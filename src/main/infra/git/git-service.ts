import {
  AppError,
  ErrorCode,
  type GitAddRes,
  type GitCommitRes,
  type GitDiffRes,
  type GitFileStatus,
  type GitPushRes,
  type GitStatusRes,
  isSafeGitRefValue,
  isSafeGitRemote,
} from '@code-agent/shared/main';
import { type SimpleGit, simpleGit } from 'simple-git';
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
 * - 实现替换：已从手写 spawn 迁移到 simple-git，接口保持稳定
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
  /** 优雅关闭（simple-git 无活跃子进程句柄暴露，保持接口兼容为 no-op） */
  dispose(): Promise<void>;
}

/**
 * GitService 默认实现（simple-git）
 *
 * 每个方法按 path 创建独立 SimpleGit 实例（baseDir 绑定），
 * 避免实例间 cwd 状态污染；simple-git 内部管理子进程与超时。
 */
class GitService implements IGitService {
  /** 创建绑定到指定仓库路径的 SimpleGit 实例（含 30s 命令超时） */
  private git(path: string): SimpleGit {
    return simpleGit({
      baseDir: path,
      timeout: { block: GIT_COMMAND_TIMEOUT_MS },
      maxConcurrentProcesses: 4,
    });
  }

  /**
   * 获取工作区状态
   *
   * simple-git status() 的 FileStatusResult 只暴露 index / working_dir 字符码，
   * 需自行推导 status / staged（本版本不填充 status/staged 字段）：
   * - index='?' → untracked（simple-git 同时放入 files 与 not_added，仅处理 files 避免重复）
   * - index='M'/'A'/'D'/'R' → staged=true
   * - working_dir='M' → modified；'D' → deleted；'R' → renamed
   * - index='U' / working_dir='U' → conflicted
   */
  async status(path: string): Promise<GitStatusRes> {
    await this.assertGitRepo(path);
    const result = await this.runGit((git) => git.status(), path);

    const files: GitFileStatus[] = [];
    for (const file of result.files) {
      const x = file.index;
      const y = file.working_dir;

      if (x === '?' || y === '?') {
        files.push({
          path: file.path,
          status: 'untracked',
          staged: false,
          oldPath: undefined,
        });
        continue;
      }

      const staged = x !== ' ' && x !== '.';
      files.push({
        path: file.path,
        status: this.mapFileStatus(x, y),
        staged,
        oldPath: file.from,
      });
    }

    return {
      branch: result.current ?? '(unknown)',
      ahead: result.ahead,
      behind: result.behind,
      files,
      clean: files.length === 0,
    };
  }

  /**
   * porcelain 字符码（index X / worktree Y）→ GitFileStatus.status
   *
   * 优先级：conflict > untracked > deleted > renamed > added > modified
   */
  private mapFileStatus(x: string, y: string): GitFileStatus['status'] {
    if (x === 'U' || y === 'U') {
      return 'conflicted';
    }
    if (y === 'D' || x === 'D') {
      return 'deleted';
    }
    if (x === 'R' || y === 'R') {
      return 'renamed';
    }
    if (x === 'A') {
      return 'added';
    }
    return 'modified';
  }

  /**
   * 获取 diff
   *
   * 参数组合（与旧实现语义一致）：
   * - staged=true：git diff --cached [<ref>] [-- <path>]
   * - staged=false：git diff [<ref>] [-- <path>]
   *   ref 默认 HEAD，staged=false + ref=HEAD 时实际查看工作区 vs 暂存区
   */
  async diff(options: GitDiffOptions): Promise<GitDiffRes> {
    const { path, ref, staged, filePath } = options;
    if (ref !== undefined && ref.length > 0 && !isSafeGitRefValue(ref)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `git diff ref 含非法字符：${ref}`);
    }
    await this.assertGitRepo(path);

    const args: string[] = [];
    if (staged) {
      args.push('--cached');
    }
    if (ref !== undefined && ref.length > 0) {
      args.push(ref);
    }
    if (filePath !== undefined && filePath.length > 0) {
      args.push('--', filePath);
    }

    const diffText = await this.runGit((git) => git.diff(args), path);
    const stats = this.parseDiffStats(diffText);

    return {
      diff: diffText,
      additions: stats.additions,
      deletions: stats.deletions,
      filesChanged: stats.filesChanged,
    };
  }

  /**
   * 统计 diff 的 additions/deletions/filesChanged
   *
   * 解析 unified diff 文本（与旧实现一致）：
   * - 'diff --git ' 开头 → filesChanged
   * - +++ / --- 文件头、@@ hunk 头不计入
   * - + 开头 → additions；- 开头 → deletions
   * - 二进制文件（'Binary files ... differ'）计入 filesChanged 不计行数
   */
  private parseDiffStats(diff: string): {
    additions: number;
    deletions: number;
    filesChanged: number;
  } {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        filesChanged += 1;
        continue;
      }
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
   * 暂存工作区改动（git add）
   *
   * paths 为空时执行 git add -A（含删除与未跟踪），
   * 否则暂存指定路径。stagedCount 通过 status 统计。
   */
  async add(options: GitAddOptions): Promise<GitAddRes> {
    const { path, paths = [] } = options;
    await this.assertGitRepo(path);

    const args: string[] = paths.length === 0 ? ['-A'] : ['--', ...paths];
    const stdout = await this.runGit((git) => git.add(args), path);

    const stagedCount = await this.countStagedFiles(path);
    return { stagedCount, stdout };
  }

  /**
   * 提交暂存区改动（git commit）
   *
   * - 默认：git commit -m <message>
   * - amend=true：git commit --amend -m <message>
   * 返回 sha / shortSha / branch / 统计信息。
   */
  async commit(options: GitCommitOptions): Promise<GitCommitRes> {
    const { path, message, amend } = options;
    await this.assertGitRepo(path);

    const result = await this.runGit(
      (git) => git.commit(message, [], amend ? { '--amend': null } : {}),
      path,
    );

    const sha = result.commit;
    const branch = result.branch;
    const shortSha = sha.length >= 7 ? sha.slice(0, 7) : sha;

    return {
      sha,
      shortSha,
      branch,
      filesChanged: result.summary.changes,
      additions: result.summary.insertions,
      deletions: result.summary.deletions,
      stdout: '',
    };
  }

  /**
   * 推送本地提交到远程（git push）
   *
   * - force=true：--force-with-lease（更安全的强制推送，禁止裸 --force）
   * - setUpstream=true：-u
   * - 失败不抛错：返回 ok=false + stderr（UI 友好提示）
   * - pushedCount：推送前后远程 SHA 对比计算
   */
  async push(options: GitPushOptions): Promise<GitPushRes> {
    const { path, remote, refspec, setUpstream, force } = options;
    if (!isSafeGitRemote(remote)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `git push remote 含非法字符：${remote}`);
    }
    if (!isSafeGitRefValue(refspec)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `git push refspec 含非法字符：${refspec}`);
    }
    await this.assertGitRepo(path);

    const beforeSha = await this.getRemoteHeadSha(path, remote, refspec);

    const pushOptions: Record<string, string | null> = {};
    if (force) {
      pushOptions['--force-with-lease'] = null;
    }
    const pushRefspec =
      refspec.length > 0 ? refspec : setUpstream ? await this.getCurrentBranch(path) : undefined;

    if (setUpstream && pushRefspec !== undefined) {
      await this.runGit((git) => git.addConfig(`branch.${pushRefspec}.remote`, remote), path);
      await this.runGit(
        (git) => git.addConfig(`branch.${pushRefspec}.merge`, `refs/heads/${pushRefspec}`),
        path,
      );
    }

    try {
      const result = await this.runGit((git) => git.push(remote, pushRefspec, pushOptions), path);

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
        stdout: result.remoteMessages.all.join('\n'),
        stderr: '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error, remote, refspec }, 'git push 失败');
      return {
        ok: false,
        pushedCount: 0,
        remote,
        refspec,
        stdout: '',
        stderr: message,
      };
    }
  }

  /** 优雅关闭：simple-git 内部管理子进程，接口兼容为 no-op */
  async dispose(): Promise<void> {}

  /**
   * 执行 simple-git 操作并统一错误分类
   *
   * @param op simple-git 操作（如 (git) => git.status()）
   * @param path 仓库路径
   * @returns simple-git 返回值
   * @throws AppError(INTERNAL_ERROR) git 命令执行失败
   */
  private async runGit<T>(op: (git: SimpleGit) => Promise<T>, path: string): Promise<T> {
    try {
      return await op(this.git(path));
    } catch (error) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `git 命令失败：${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
        { path },
      );
    }
  }

  /**
   * 校验路径为 git 仓库
   *
   * 通过 git rev-parse --is-inside-work-tree 判断，失败则抛 INVALID_INPUT。
   * 同时隐式校验 git 命令是否可用（git 不在 PATH 时会失败）。
   */
  private async assertGitRepo(path: string): Promise<void> {
    if (!path || path.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, '路径不能为空');
    }
    try {
      await this.git(path).revparse(['--is-inside-work-tree']);
    } catch (error) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        '路径不是 git 仓库或 git 命令不可用',
        error instanceof Error ? error : undefined,
        {
          path,
        },
      );
    }
  }

  /** 统计已暂存文件数（通过 status 结果） */
  private async countStagedFiles(path: string): Promise<number> {
    const result = await this.git(path).status();
    return result.files.filter(
      (file) => file.index !== ' ' && file.index !== '.' && file.index !== '?',
    ).length;
  }

  /** 获取当前分支名（--set-upstream 需要；失败回退空串） */
  private async getCurrentBranch(path: string): Promise<string> {
    try {
      const stdout = await this.git(path).revparse(['--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      return branch.length > 0 && branch !== 'HEAD' ? branch : '';
    } catch {
      return '';
    }
  }

  /** 获取远程分支的 HEAD SHA（基于本地跟踪分支，失败返回 null） */
  private async getRemoteHeadSha(
    path: string,
    remote: string,
    refspec: string,
  ): Promise<string | null> {
    try {
      const arg = refspec.length > 0 ? `${remote}/${refspec}` : '@{upstream}';
      const stdout = await this.git(path).revparse([arg]);
      const trimmed = stdout.trim();
      return trimmed.length === 40 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /** 计算两个 SHA 之间的 commit 数（失败返回 0） */
  private async countCommitsBetween(
    path: string,
    beforeSha: string,
    afterSha: string,
  ): Promise<number> {
    try {
      const stdout = await this.git(path).raw(['rev-list', '--count', `${beforeSha}..${afterSha}`]);
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
 * 返回类型为 IGitService 接口而非具体类，强制调用方面向接口编程。
 */
export function getGitService(): IGitService {
  if (gitService === null) {
    gitService = new GitService();
  }
  return gitService;
}

/**
 * 重置 GitService（仅测试用）
 */
export function resetGitService(): void {
  gitService = null;
}
