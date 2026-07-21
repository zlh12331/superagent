// src/main/infra/git/git-service.ts
// GitService：Git CLI 封装（只读查询）
// ──────────────────────────────────────────────────────────────
// 职责：
// - status：获取工作区状态（branch/ahead/behind/files/clean）
// - diff：获取 unified diff 文本 + 统计（additions/deletions/filesChanged）
// - dispose：无外部资源（每次调用 spawn 短任务子进程），无需清理
//
// 设计：
// - 通过 child_process.spawn('git', [...args]) 调用系统 git CLI
// - path 可为仓库根或子目录，内部用 git rev-parse --show-toplevel 解析根目录
// - status 用 git status --porcelain=v2 -b 获取结构化输出
// - diff 用 git diff [--cached] [<ref>] [-- <path>] 获取 unified diff
// - additions/deletions 通过解析 diff 中的 +/- 行统计（^+++ ^--- 不计）
// - 错误分类：非 git 仓库 → INVALID_INPUT；git 命令失败 → INTERNAL_ERROR
// - 单例模式：与 FileService / SearchService 一致，便于统一生命周期管理
// ──────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import type { GitDiffRes, GitFileStatus, GitStatusRes } from '@novel-writer/shared';
import { AppError, ErrorCode } from '@novel-writer/shared';

/**
 * diff 方法入参
 *
 * 与 GitDiffReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface GitDiffOptions {
  /** Git 仓库路径（绝对路径，可为仓库根或子目录） */
  readonly path: string;
  /** 对比的 ref（默认 'HEAD'） */
  readonly ref: string;
  /** 是否只看暂存区（git diff --cached） */
  readonly staged: boolean;
  /** 指定文件路径（可选，省略时查看整个仓库 diff） */
  readonly filePath: string | undefined;
}

/**
 * GitService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 git CLI
 * - 未来扩展：替换为 isomorphic-git 等纯 JS 实现
 */
export interface IGitService {
  /** 获取工作区状态 */
  status(path: string): Promise<GitStatusRes>;
  /** 获取 diff */
  diff(options: GitDiffOptions): Promise<GitDiffRes>;
  /** 优雅关闭（无外部资源，空实现） */
  dispose(): Promise<void>;
}

/**
 * GitService 默认实现
 *
 * 内部不持有长期状态（每次 status/diff 都启动新的子进程）。
 * dispose 为空操作（与 SearchService 一致保留接口，便于未来扩展）。
 *
 * 错误分类：
 * - 路径非 git 仓库：INVALID_INPUT（git rev-parse 失败）
 * - git 命令执行失败：INTERNAL_ERROR
 * - stdout 解析失败：INTERNAL_ERROR
 */
class GitService implements IGitService {
  /**
   * 获取工作区状态
   *
   * 流程：
   * 1. git rev-parse --show-toplevel：解析仓库根目录（非 git 仓库则报错）
   * 2. git status --porcelain=v2 -b：获取分支 + 文件状态
   * 3. git rev-list --count @{upstream}...HEAD：获取 ahead/behind（失败则 0,0）
   * 4. 解析 porcelain v2 输出，组装 GitStatusRes
   *
   * porcelain v2 输出格式：
   *   # branch.head master
   *   # branch.upstream origin/master
   *   # branch.ab +2 -1
   *   1 .M N... 100644 100644 <sha> <sha> path/to/file
   *   1 .D N... 100644 000000 <sha> <sha> path/to/deleted
   *   2 R. N... 100644 100644 <sha> <sha> R100 path/old\t path/new
   *   ? path/to/untracked
   *   u UAA N... 100644 100644 <sha> <sha> path/conflict
   *
   * 解析规则：
   * - # branch.head：当前分支名
   * - # branch.ab +N -M：领先 N / 落后 M
   * - 1 XY ...：普通文件状态（X=index, Y=worktree）
   * - 2 R. ...：rename（old → new）
   * - ? path：untracked
   * - u ...：conflict
   */
  async status(path: string): Promise<GitStatusRes> {
    // 1. 校验为 git 仓库（同时解析根目录）
    await this.assertGitRepo(path);

    // 2. 获取 porcelain v2 状态
    const { stdout } = await this.runGit(['status', '--porcelain=v2', '-b'], path);
    const lines = stdout.split('\n');

    let branch = '(unknown)';
    let ahead = 0;
    let behind = 0;
    const files: GitFileStatus[] = [];

    for (const line of lines) {
      if (line === '') {
        continue;
      }

      // # branch.head <name>
      if (line.startsWith('# branch.head ')) {
        branch = line.slice('# branch.head '.length).trim();
        continue;
      }

      // # branch.ab +N -M
      if (line.startsWith('# branch.ab ')) {
        const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
        if (match !== null) {
          ahead = Number.parseInt(match[1] ?? '0', 10);
          behind = Number.parseInt(match[2] ?? '0', 10);
        }
        continue;
      }

      // 其他 # 开头的行（branch.oid / branch.upstream）忽略
      if (line.startsWith('#')) {
        continue;
      }

      // ? path：untracked
      if (line.startsWith('? ')) {
        files.push({
          path: line.slice(2),
          status: 'untracked',
          staged: false,
          oldPath: undefined,
        });
        continue;
      }

      // 1 XY ...：普通文件状态
      if (line.startsWith('1 ')) {
        const file = this.parseOrdinaryLine(line);
        if (file !== null) {
          files.push(file);
        }
      }

      // 2 R. ...：rename
      if (line.startsWith('2 ')) {
        const file = this.parseRenameLine(line);
        if (file !== null) {
          files.push(file);
        }
        continue;
      }

      // u ...：conflict
      if (line.startsWith('u ')) {
        const file = this.parseConflictLine(line);
        if (file !== null) {
          files.push(file);
        }
      }

      // 其他行忽略
    }

    return {
      branch,
      ahead,
      behind,
      files,
      clean: files.length === 0,
    };
  }

  /**
   * 获取 diff
   *
   * 流程：
   * 1. 校验为 git 仓库
   * 2. 构建 git diff 参数（--cached / ref / -- path）
   * 3. 执行 git diff 获取 unified diff 文本
   * 4. 统计 additions/deletions/filesChanged
   *
   * 参数组合：
   * - staged=true：git diff --cached [<ref>] [-- <path>]
   * - staged=false：git diff [<ref>] [-- <path>]
   *   ref 默认 HEAD，但 staged=false 且 ref=HEAD 时实际查看工作区 vs 暂存区
   *
   * 注意：ref 与 staged 的组合语义：
   * - staged=true + ref=HEAD：暂存区 vs HEAD（显示已暂存的改动）
   * - staged=false + ref=HEAD：工作区 vs 暂存区（显示未暂存的改动）
   * - staged=false + ref=origin/master：工作区 vs origin/master
   */
  async diff(options: GitDiffOptions): Promise<GitDiffRes> {
    const { path, ref, staged, filePath } = options;

    await this.assertGitRepo(path);

    // 构建 git diff 参数
    const args: string[] = ['diff'];
    if (staged) {
      args.push('--cached');
    }
    args.push(ref);
    if (filePath !== undefined && filePath.length > 0) {
      args.push('--', filePath);
    }

    const { stdout } = await this.runGit(args, path);

    // 统计 additions/deletions/filesChanged
    const stats = this.parseDiffStats(stdout);

    return {
      diff: stdout,
      additions: stats.additions,
      deletions: stats.deletions,
      filesChanged: stats.filesChanged,
    };
  }

  /**
   * 优雅关闭（无外部资源，空实现）
   *
   * GitService 每次调用都启动新的子进程，不持有长期资源。
   * 保留 dispose 方法以满足接口一致性，便于未来扩展（如缓存 git 仓库状态）。
   */
  async dispose(): Promise<void> {
    // 无操作
  }

  // ─── 内部辅助方法 ───────────────────────────────────

  /**
   * 校验路径为 git 仓库
   *
   * 通过 git rev-parse --is-inside-work-tree 判断，失败则抛 INVALID_INPUT。
   * 同时隐式校验 git 命令是否可用（git 不在 PATH 时会 spawn 失败）。
   */
  private async assertGitRepo(path: string): Promise<void> {
    if (!path || path.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
    }
    try {
      await this.runGit(['rev-parse', '--is-inside-work-tree'], path);
    } catch (error) {
      // 非 git 仓库或 git 命令失败
      throw new AppError(ErrorCode.INVALID_INPUT, '路径不是 git 仓库或 git 命令不可用', error, {
        path,
      });
    }
  }

  /**
   * 执行 git 命令并返回 stdout
   *
   * @param args git 命令参数（如 ['status', '--porcelain=v2', '-b']）
   * @param cwd 工作目录
   * @returns stdout 输出（字符串）
   * @throws AppError(INTERNAL_ERROR) git 命令执行失败
   */
  private runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      if (child.stdout !== null) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf-8');
        });
      }
      if (child.stderr !== null) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
      }

      child.on('error', (err: Error) => {
        reject(new AppError(ErrorCode.INTERNAL_ERROR, 'git 命令启动失败', err, { args, cwd }));
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new AppError(ErrorCode.INTERNAL_ERROR, `git 命令失败（code=${code}）`, undefined, {
            args,
            cwd,
            stderr,
          }),
        );
      });
    });
  }

  /**
   * 解析 porcelain v2 普通文件状态行
   *
   * 行格式：1 XY N... mode1 mode2 sha1 sha2 path
   * 例如：1 .M N... 100644 100644 <sha> <sha> src/file.ts
   *
   * XY 状态码：
   * - ' '：未修改
   * - M：modified
   * - A：added（新增到暂存区）
   * - D：deleted
   * - R：rename（但 rename 在 porcelain v2 中以 2 开头的行单独表示）
   * - C：copy
   * - U：unmerged
   *
   * X 是 index 状态（暂存区），Y 是 worktree 状态（工作区）。
   * staged = X !== ' ' && X !== '?'（X 为非空状态表示已 git add）
   */
  private parseOrdinaryLine(line: string): GitFileStatus | null {
    // 1 XY N... mode1 mode2 sha1 sha2 path
    // 拆分后 fields[0]='1' fields[1]='XY' fields[2..5] 为 N/mode/sha
    const fields = line.split('\t');
    if (fields.length < 2) {
      return null;
    }
    const meta = fields[0] ?? '';
    const path = fields[1] ?? '';
    // meta = '1 XY N... 100644 100644 sha1 sha2'
    const metaFields = meta.split(' ');
    const xy = metaFields[1] ?? '  ';
    const x = xy[0] ?? ' ';
    const y = xy[1] ?? ' ';

    // 优先用 Y（worktree）状态判断，其次用 X（index）
    // 因为 status 字段表示"文件的当前状态"，worktree 优先
    const status = this.xyToStatus(x, y);
    const staged = x !== ' ' && x !== '?';

    // oldPath 仅 rename 行有值，ordinary 行显式传 undefined 满足 exactOptionalPropertyTypes
    return { path, status, staged, oldPath: undefined };
  }

  /**
   * 解析 porcelain v2 rename 行
   *
   * 行格式：2 R. N... mode1 mode2 sha1 sha2 R<score>\told_path\tnew_path
   * 例如：2 R. N... 100644 100644 sha1 sha2 R100\told.ts\tnew.ts
   */
  private parseRenameLine(line: string): GitFileStatus | null {
    // 2 R. N... mode1 mode2 sha1 sha2 R100\told\tnew
    const fields = line.split('\t');
    if (fields.length < 3) {
      return null;
    }
    const newPath = fields[2] ?? '';
    const oldPath = fields[1] ?? '';

    return {
      path: newPath,
      status: 'renamed',
      staged: true,
      oldPath,
    };
  }

  /**
   * 解析 porcelain v2 conflict 行
   *
   * 行格式：u UAA N... mode1 mode2 mode3 sha1 sha2 sha3 path
   */
  private parseConflictLine(line: string): GitFileStatus | null {
    const fields = line.split('\t');
    if (fields.length < 2) {
      return null;
    }
    const path = fields[1] ?? '';
    // conflict 行无 oldPath，显式传 undefined 满足 exactOptionalPropertyTypes
    return {
      path,
      status: 'conflicted',
      staged: false,
      oldPath: undefined,
    };
  }

  /**
   * porcelain v2 XY 状态码 → GitFileStatus.status
   *
   * 优先用 Y（worktree）状态判断：
   * - Y='M' → modified
   * - Y='D' → deleted
   * - X='A' 且 Y=' ' → added（已暂存的新文件）
   * - X='R' → renamed（由 2 开头的行处理，这里兜底）
   * - 其他 → modified（fallback）
   */
  private xyToStatus(x: string, y: string): GitFileStatus['status'] {
    if (y === 'M') {
      return 'modified';
    }
    if (y === 'D') {
      return 'deleted';
    }
    if (x === 'A') {
      return 'added';
    }
    if (x === 'R') {
      return 'renamed';
    }
    // 其他状态（如 C/U）统一归为 modified
    return 'modified';
  }

  /**
   * 统计 diff 的 additions/deletions/filesChanged
   *
   * 解析 unified diff 文本：
   * - +++ / --- 开头的行是文件头（不计入 additions/deletions）
   * - + 开头的行是 additions
   * - - 开头的行是 deletions
   * - @@ 开头的行是 hunk header（不计入）
   * - 其他行是上下文（不计入）
   *
   * filesChanged 通过统计 'diff --git' 行数计算。
   *
   * 注意：二进制文件 diff 会显示 'Binary files ... differ'，
   * 此时不计入 additions/deletions，但会计入 filesChanged。
   */
  private parseDiffStats(diff: string): {
    additions: number;
    deletions: number;
    filesChanged: number;
  } {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        filesChanged += 1;
        continue;
      }
      // 跳过 +++ / --- 头部（避免计入文件名行）
      if (line.startsWith('+++') || line.startsWith('---')) {
        continue;
      }
      if (line.startsWith('@@')) {
        continue;
      }
      if (line.startsWith('+')) {
        additions += 1;
        continue;
      }
      if (line.startsWith('-')) {
        deletions += 1;
      }
    }

    return { additions, deletions, filesChanged };
  }
}

/** GitService 单例（内部按具体实现类持有，外部暴露为 IGitService 接口） */
let gitService: GitService | null = null;

/**
 * 获取 GitService 单例
 *
 * 整个应用生命周期共享一个实例。
 *
 * 返回类型为 IGitService 接口而非具体类：
 * - 强制调用方面向接口编程，不依赖 GitService 内部细节
 * - ServiceContainer 注入到 IPC handler 时类型一致
 */
export function getGitService(): IGitService {
  if (gitService === null) {
    gitService = new GitService();
  }
  return gitService;
}

/**
 * 重置 GitService（仅测试用）
 *
 * GitService 无外部资源，仅清空单例缓存。
 */
export function resetGitService(): void {
  gitService = null;
}
