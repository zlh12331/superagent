// src/main/infra/git/git-service.ts
// GitService：Git CLI 封装（只读查询 + 写操作）
// ──────────────────────────────────────────────────────────────
// 职责：
// - status：获取工作区状态（branch/ahead/behind/files/clean）
// - diff：获取 unified diff 文本 + 统计（additions/deletions/filesChanged）
// - add：暂存工作区改动到暂存区（git add）
// - commit：提交暂存区改动（git commit -m，支持 --amend）
// - push：推送本地提交到远程（git push，支持 --force-with-lease 和 -u）
// - dispose：kill 所有活跃子进程（应用退出兜底）
//
// 设计：
// - 通过 child_process.spawn('git', [...args]) 调用系统 git CLI
// - path 可为仓库根或子目录，内部用 git rev-parse --is-inside-work-tree 校验
// - status 用 git status --porcelain=v2 -b 获取结构化输出
// - diff 用 git diff [--cached] [<ref>] [-- <path>] 获取 unified diff
// - additions/deletions 通过解析 diff 中的 +/- 行统计（^+++ ^--- 不计）
// - push 失败不抛错，返回 ok=false 便于 UI 友好提示
// - 错误分类：非 git 仓库 → INVALID_INPUT；git 命令失败 → INTERNAL_ERROR
// - 单例模式：与 FileService / SearchService 一致，便于统一生命周期管理
//
// 内存泄漏防护（M5）：
// - activeProcesses 追踪所有活跃子进程，dispose 时统一 kill
// - 每条 git 命令强制 30s 超时，超时后 SIGTERM 子进程并 reject
//   避免 git 命令挂死（如等待凭证输入、ssh 卡住）导致 Promise 永久 pending
// - 子进程 close/error 时主动从 activeProcesses 移除 + clearTimeout
// ──────────────────────────────────────────────────────────────

import { type ChildProcess, spawn } from 'node:child_process';
import type {
  GitAddRes,
  GitCommitRes,
  GitDiffRes,
  GitFileStatus,
  GitPushRes,
  GitStatusRes,
} from '@novel-writer/shared';
import { AppError, ErrorCode } from '@novel-writer/shared';
import { logger } from '../../utils/logger';

/** 单条 git 命令的默认超时（毫秒）：30s 足够覆盖 status/diff/commit/push */
const GIT_COMMAND_TIMEOUT_MS = 30_000;

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
 * add 方法入参
 *
 * 与 GitAddReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface GitAddOptions {
  /** Git 仓库路径（绝对路径） */
  readonly path: string;
  /** 要暂存的路径列表（相对 path 或绝对路径），空数组时执行 git add -A */
  readonly paths: readonly string[];
}

/**
 * commit 方法入参
 *
 * 与 GitCommitReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface GitCommitOptions {
  /** Git 仓库路径（绝对路径） */
  readonly path: string;
  /** 提交信息 */
  readonly message: string;
  /** 是否 amend */
  readonly amend: boolean;
}

/**
 * push 方法入参
 *
 * 与 GitPushReqSchema 字段对齐，类型独立定义以便测试 mock。
 */
export interface GitPushOptions {
  /** Git 仓库路径（绝对路径） */
  readonly path: string;
  /** 远程名（默认 'origin'） */
  readonly remote: string;
  /** 引用规格（空字符串时推送当前分支到同名远程分支） */
  readonly refspec: string;
  /** 是否设置上游 */
  readonly setUpstream: boolean;
  /** 是否使用 --force-with-lease */
  readonly force: boolean;
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
  /** 暂存工作区改动（git add） */
  add(options: GitAddOptions): Promise<GitAddRes>;
  /** 提交暂存区改动（git commit） */
  commit(options: GitCommitOptions): Promise<GitCommitRes>;
  /** 推送本地提交到远程（git push） */
  push(options: GitPushOptions): Promise<GitPushRes>;
  /**
   * 优雅关闭：kill 所有活跃子进程
   *
   * 应用退出时调用，避免 spawn 出去的 git 子进程未结束导致进程退出延迟。
   * 正常完成的子进程会从 activeProcesses 自动移除，dispose 仅清理异常残留的子进程。
   */
  dispose(): Promise<void>;
}

/**
 * GitService 默认实现
 *
 * 内部通过 activeProcesses 追踪所有活跃子进程：
 * - runGit 启动子进程时加入 Set，close/error 时移除
 * - dispose 时统一 SIGTERM 残留子进程（应用退出兜底）
 *
 * 每条 git 命令强制超时（GIT_COMMAND_TIMEOUT_MS），避免：
 * - git 等待凭证输入（credential helper 弹窗）挂死
 * - ssh 鉴权卡住（远程仓库不可达）
 * - 子进程异常不退出导致 Promise 永久 pending
 *
 * 错误分类：
 * - 路径非 git 仓库：INVALID_INPUT（git rev-parse 失败）
 * - git 命令执行失败：INTERNAL_ERROR
 * - stdout 解析失败：INTERNAL_ERROR
 */
class GitService implements IGitService {
  /**
   * 活跃子进程集合：用于 dispose 时统一清理
   *
   * 正常完成的子进程会从 Set 自动移除（close 事件触发），
   * 仅在异常退出 / dispose 调用时仍存活的子进程会留在 Set 中。
   */
  private readonly activeProcesses = new Set<ChildProcess>();
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
   * 优雅关闭：kill 所有活跃子进程
   *
   * 应用退出时调用，避免异常残留的 git 子进程句柄泄漏导致进程退出延迟。
   * 正常完成的子进程会从 activeProcesses 自动移除，dispose 仅清理异常残留。
   *
   * 幂等：多次调用安全（Set 已清空时为 no-op）。
   */
  async dispose(): Promise<void> {
    if (this.activeProcesses.size === 0) {
      return;
    }
    const processes = Array.from(this.activeProcesses);
    for (const proc of processes) {
      try {
        // SIGTERM 优雅终止（SIGKILL 会损坏子进程输出缓冲区）
        proc.kill('SIGTERM');
      } catch (error) {
        logger.warn({ error }, 'GitService 子进程 kill 失败');
      }
    }
    this.activeProcesses.clear();
    logger.info({}, 'GitService 所有子进程已清理');
  }

  /**
   * 暂存工作区改动（git add）
   *
   * 流程：
   * 1. 校验为 git 仓库
   * 2. 构建 git add 参数（paths 为空时执行 git add -A）
   * 3. 执行 git add
   * 4. 通过 git status --porcelain=v2 统计已暂存文件数
   *
   * 注意：paths 内的相对路径基于 path 解析（与 schema 描述一致）。
   * git add 不返回有用信息，stagedCount 通过 status 后查得。
   */
  async add(options: GitAddOptions): Promise<GitAddRes> {
    const { path, paths } = options;
    await this.assertGitRepo(path);

    const args: string[] = ['add'];
    if (paths.length === 0) {
      args.push('-A');
    } else {
      args.push('--', ...paths);
    }

    const { stdout } = await this.runGit(args, path);

    // 通过 status 统计已暂存文件数（git add 输出无结构化信息）
    const stagedCount = await this.countStagedFiles(path);

    return { stagedCount, stdout };
  }

  /**
   * 提交暂存区改动（git commit）
   *
   * 流程：
   * 1. 校验为 git 仓库
   * 2. 构建 git commit 参数：
   *    - 默认：git commit -m <message>
   *    - amend=false 且 message：git commit -m <message>
   *    - amend=true 且 message：git commit --amend -m <message>
   * 3. 执行 git commit，解析 stdout 获取新提交 SHA
   * 4. 通过 git show --stat 获取本次提交的统计信息
   *
   * 解析 commit stdout（典型输出）：
   *   [master abc1234] message
   *    1 file changed, 1 insertion(+), 1 deletion(-)
   *
   * 注意：amend=true 时不使用 --no-edit（保留 schema 提供的 message 覆盖原 message）。
   */
  async commit(options: GitCommitOptions): Promise<GitCommitRes> {
    const { path, message, amend } = options;
    await this.assertGitRepo(path);

    const args: string[] = ['commit'];
    if (amend) {
      args.push('--amend');
    }
    args.push('-m', message);

    const { stdout } = await this.runGit(args, path);

    // 解析新提交的 SHA：[branch abc1234] message
    const shaMatch = stdout.match(/^\[(\S+)\s+([0-9a-f]{7,40})\]/m);
    const branch = shaMatch?.[1] ?? '(unknown)';
    const shortSha = shaMatch?.[2] ?? '';
    const sha = shortSha.length === 40 ? shortSha : await this.getHeadSha(path);
    const realShortSha = shortSha.length >= 7 ? shortSha.slice(0, 7) : sha.slice(0, 7);

    // 获取提交统计（filesChanged/additions/deletions）
    const stats = await this.getCommitStats(path, sha);

    return {
      sha,
      shortSha: realShortSha,
      branch,
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      stdout,
    };
  }

  /**
   * 推送本地提交到远程（git push）
   *
   * 流程：
   * 1. 校验为 git 仓库
   * 2. 构建 git push 参数：
   *    - force=true：--force-with-lease（更安全的强制推送）
   *    - setUpstream=true：-u
   *    - 远程名 + refspec
   * 3. 执行 git push，捕获 stdout 和 stderr
   * 4. 解析推送的提交数（从 stderr 的 "remote: Counting objects" 或 stdout 的 "abc..def" 解析）
   *
   * 安全策略：
   * - 禁止 --force：使用 --force-with-lease 替代，避免覆盖他人提交
   * - git push 的进度信息在 stderr，stdout 通常为空
   *
   * 解析 pushedCount（从 "To github.com:...\n   abc..def  master -> master"）：
   * 若推送的 commit 数 > 0，输出形如 "abc1234..def5678"，需要计算两个 SHA 之间的 commit 数。
   * 简化处理：直接用 git rev-list --count <oldSha>..<newSha> 计算。
   */
  async push(options: GitPushOptions): Promise<GitPushRes> {
    const { path, remote, refspec, setUpstream, force } = options;
    await this.assertGitRepo(path);

    // 记录推送前的远程 SHA，用于计算推送的 commit 数
    const beforeSha = await this.getRemoteHeadSha(path, remote, refspec);

    const args: string[] = ['push'];
    if (setUpstream) {
      args.push('-u');
    }
    if (force) {
      args.push('--force-with-lease');
    }
    args.push(remote);
    if (refspec.length > 0) {
      args.push(refspec);
    }

    let pushResult: { stdout: string; stderr: string };
    try {
      pushResult = await this.runGit(args, path);
    } catch (error) {
      // git push 失败时（远程拒绝、网络问题）返回 ok=false 而非抛出
      // runGit 失败时将 stderr/stdout 封装到 AppError.details（见 runGit 实现）
      const appError = error as AppError;
      const details = appError.details as { stderr?: string; stdout?: string } | undefined;
      const stderr = details?.stderr ?? '';
      const stdout = details?.stdout ?? '';
      return {
        ok: false,
        pushedCount: 0,
        remote,
        refspec,
        stdout,
        stderr: stderr || appError.message,
      };
    }

    // 计算推送的 commit 数
    const afterSha = await this.getRemoteHeadSha(path, remote, refspec);
    let pushedCount = 0;
    if (beforeSha !== null && afterSha !== null && beforeSha !== afterSha) {
      pushedCount = await this.countCommitsBetween(path, beforeSha, afterSha);
    }

    return {
      ok: true,
      pushedCount,
      remote,
      refspec,
      stdout: pushResult.stdout,
      stderr: pushResult.stderr,
    };
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
      this.activeProcesses.add(child);

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

      // 超时控制：30s 内未完成则 SIGTERM 子进程并 reject
      // 避免 git 等待凭证输入 / ssh 卡住 / 远程不可达导致 Promise 永久 pending
      const timeoutId = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // 子进程可能已退出，kill 失败忽略
        }
        reject(
          new AppError(
            ErrorCode.INTERNAL_ERROR,
            `git 命令超时（${GIT_COMMAND_TIMEOUT_MS}ms）`,
            undefined,
            { args, cwd },
          ),
        );
      }, GIT_COMMAND_TIMEOUT_MS);

      // 统一清理逻辑：清超时定时器 + 从 activeProcesses 移除
      // 无论 close/error 都需调用，避免定时器泄漏和 Set 无限增长
      const cleanup = (): void => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(child);
      };

      child.on('error', (err: Error) => {
        cleanup();
        reject(new AppError(ErrorCode.INTERNAL_ERROR, 'git 命令启动失败', err, { args, cwd }));
      });

      child.on('close', (code: number | null) => {
        cleanup();
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

  /**
   * 统计已暂存文件数
   *
   * 通过 git status --porcelain=v2 解析 X 状态码非空且非 '?' 的文件行。
   * 用于 git add 后向调用方反馈暂存结果。
   */
  private async countStagedFiles(path: string): Promise<number> {
    const { stdout } = await this.runGit(['status', '--porcelain=v2'], path);
    let count = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('1 ')) {
        const meta = line.split('\t')[0] ?? '';
        const xy = meta.split(' ')[1] ?? '  ';
        const x = xy[0] ?? ' ';
        if (x !== ' ' && x !== '?') count += 1;
      } else if (line.startsWith('2 ')) {
        // rename 行总是已暂存
        count += 1;
      }
    }
    return count;
  }

  /**
   * 获取当前 HEAD 的 SHA（40 字符）
   *
   * 通过 git rev-parse HEAD 获取，失败时返回空字符串。
   */
  private async getHeadSha(path: string): Promise<string> {
    try {
      const { stdout } = await this.runGit(['rev-parse', 'HEAD'], path);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * 获取指定 commit 的统计信息
   *
   * 通过 git show --stat --numstat 解析：
   * - filesChanged：统计 "N file(s) changed" 行
   * - additions/deletions：从 "N insertion(s)(+)" / "N deletion(s)(-)" 行解析
   *
   * 典型输出（git show --stat --oneline）：
   *   abc1234 (HEAD -> master) message
   *    file1.ts | 2 +-
   *    file2.ts | 10 +++++-----
   *    2 files changed, 6 insertions(+), 6 deletions(-)
   */
  private async getCommitStats(
    path: string,
    sha: string,
  ): Promise<{ filesChanged: number; additions: number; deletions: number }> {
    try {
      const { stdout } = await this.runGit(['show', '--stat', '--oneline', sha], path);
      const statsMatch = stdout.match(
        /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
      );
      return {
        filesChanged: statsMatch ? Number.parseInt(statsMatch[1] ?? '0', 10) : 0,
        additions: statsMatch ? Number.parseInt(statsMatch[2] ?? '0', 10) : 0,
        deletions: statsMatch ? Number.parseInt(statsMatch[3] ?? '0', 10) : 0,
      };
    } catch {
      return { filesChanged: 0, additions: 0, deletions: 0 };
    }
  }

  /**
   * 获取远程分支的 HEAD SHA
   *
   * 通过 git rev-parse <remote>/<branch> 获取（基于本地缓存的远程跟踪分支）。
   * 用于 push 前后对比 SHA 计算推送的 commit 数。
   *
   * refspec 为空时，使用当前分支对应的远程跟踪分支。
   * 失败时返回 null（可能是远程分支不存在或网络问题）。
   */
  private async getRemoteHeadSha(
    path: string,
    remote: string,
    refspec: string,
  ): Promise<string | null> {
    try {
      // refspec 为空时，用 @{upstream} 获取当前分支的远程跟踪分支
      const arg = refspec.length > 0 ? `${remote}/${refspec}` : '@{upstream}';
      const { stdout } = await this.runGit(['rev-parse', arg], path);
      const trimmed = stdout.trim();
      return trimmed.length === 40 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * 计算两个 SHA 之间的 commit 数
   *
   * 通过 git rev-list --count <beforeSha>..<afterSha> 获取。
   * 失败时返回 0。
   */
  private async countCommitsBetween(
    path: string,
    beforeSha: string,
    afterSha: string,
  ): Promise<number> {
    try {
      const { stdout } = await this.runGit(
        ['rev-list', '--count', `${beforeSha}..${afterSha}`],
        path,
      );
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
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
