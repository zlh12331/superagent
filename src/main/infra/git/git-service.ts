// git-service.ts：git 操作服务——status/diff/add/commit/push（simple-git 承载，渲染层 git 面板后端）
// 安全面：ref/remote 均过 shared 白名单校验（isSafeGitRefValue/isSafeGitRemote）才进命令行
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

// 单命令 30s 超时 + 并发 4：push 慢但 diff/status 快，共用一档防挂死
const GIT_COMMAND_TIMEOUT_MS = 30_000;

export interface GitDiffOptions {
  readonly path: string;
  readonly ref: string;
  readonly staged: boolean;
  readonly filePath: string | undefined;
}

export interface GitAddOptions {
  readonly path: string;
  readonly paths: readonly string[];
}

export interface GitCommitOptions {
  readonly path: string;
  readonly message: string;
  readonly amend: boolean;
}

export interface GitPushOptions {
  readonly path: string;
  readonly remote: string;
  readonly refspec: string;
  readonly setUpstream: boolean;
  readonly force: boolean;
}

/** git 服务接口（IPC handler 消费；所有方法路径都须先过 assertGitRepo） */
export interface IGitService {
  status(path: string): Promise<GitStatusRes>;
  diff(options: GitDiffOptions): Promise<GitDiffRes>;
  add(options: GitAddOptions): Promise<GitAddRes>;
  commit(options: GitCommitOptions): Promise<GitCommitRes>;
  push(options: GitPushOptions): Promise<GitPushRes>;
  dispose(): Promise<void>;
}

class GitService implements IGitService {
  // 每次调用新建 SimpleGit（轻量对象）：避免缓存实例的 baseDir 与请求路径错配
  private git(path: string): SimpleGit {
    return simpleGit({
      baseDir: path,
      timeout: { block: GIT_COMMAND_TIMEOUT_MS },
      maxConcurrentProcesses: 4,
    });
  }

  async status(path: string): Promise<GitStatusRes> {
    await this.assertGitRepo(path);
    const result = await this.runGit((git) => git.status(), path);

    // status 文件归一：x=暂存区状态 y=工作区状态；'?' 未跟踪；staged = 暂存区有记录
    // （'.' 表示与 HEAD 一致只在工作区变化，不算 staged）
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

  // porcelain 状态码映射：U=冲突 > D=删除 > R=重命名 > A=新增 > 其余 modified
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

  // diff 统计手写解析（+/- 行计数，剔除 +++/---/@@ 头）：simple-git 的 numstat 对二进制
  // 文件给出 '-' 计数，逐行解析行为与渲染层展示一致
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

  async add(options: GitAddOptions): Promise<GitAddRes> {
    const { path, paths = [] } = options;
    await this.assertGitRepo(path);

    // 无指定路径 = 全部暂存（-A）；有路径用 -- 分隔防路径被当选项解析
    const args: string[] = paths.length === 0 ? ['-A'] : ['--', ...paths];
    const stdout = await this.runGit((git) => git.add(args), path);

    const stagedCount = await this.countStagedFiles(path);
    return { stagedCount, stdout };
  }

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

  async push(options: GitPushOptions): Promise<GitPushRes> {
    const { path, remote, refspec, setUpstream, force } = options;
    // remote/refspec 是用户可控的命令行参数，白名单校验必须先于任何拼接
    if (!isSafeGitRemote(remote)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `git push remote 含非法字符：${remote}`);
    }
    if (!isSafeGitRefValue(refspec)) {
      throw new AppError(ErrorCode.INVALID_INPUT, `git push refspec 含非法字符：${refspec}`);
    }
    await this.assertGitRepo(path);

    const beforeSha = await this.getRemoteHeadSha(path, remote, refspec);

    const pushOptions: Record<string, string | null> = {};
    // force 用 --force-with-lease 而非 -f：远端在本地不知情时前进了仍会拒绝，防覆盖他人提交
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

  async dispose(): Promise<void> {}

  // 统一错误归一：simple-git 的裸错误包成 AppError（message 带原话，供渲染层展示）
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

  private async countStagedFiles(path: string): Promise<number> {
    const result = await this.git(path).status();
    return result.files.filter(
      (file) => file.index !== ' ' && file.index !== '.' && file.index !== '?',
    ).length;
  }

  private async getCurrentBranch(path: string): Promise<string> {
    try {
      const stdout = await this.git(path).revparse(['--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      return branch.length > 0 && branch !== 'HEAD' ? branch : '';
    } catch {
      return '';
    }
  }

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

let gitService: GitService | null = null;

export function getGitService(): IGitService {
  if (gitService === null) {
    gitService = new GitService();
  }
  return gitService;
}

export function resetGitService(): void {
  gitService = null;
}
