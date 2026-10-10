import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { resolveAgentsMd } from './agents-md';

interface GitSummary {
  readonly branch: string;
  readonly clean: boolean;
  readonly changedFiles: number;
}

interface GitSummaryView {
  readonly branch: string;
  readonly status: string;
}

export type GitSummaryProvider = (workingDir: string) => Promise<GitSummary | null>;

const GIT_SUMMARY_TTL_MS = 2000;

export function gitSummaryProviderFrom(
  getStatus: (workingDir: string) => Promise<{
    readonly branch: string;
    readonly clean: boolean;
    readonly files: readonly unknown[];
  }>,
): GitSummaryProvider {
  const cache = new Map<string, { readonly summary: GitSummary | null; readonly at: number }>();
  const inflight = new Map<string, Promise<GitSummary | null>>();
  return async (workingDir) => {
    const cached = cache.get(workingDir);
    if (cached !== undefined && Date.now() - cached.at < GIT_SUMMARY_TTL_MS) {
      return cached.summary;
    }
    const pending = inflight.get(workingDir);
    if (pending !== undefined) {
      return pending;
    }
    const query = (async () => {
      const status = await getStatus(workingDir);
      return { branch: status.branch, clean: status.clean, changedFiles: status.files.length };
    })();
    inflight.set(workingDir, query);
    try {
      const summary = await query;
      cache.set(workingDir, { summary, at: Date.now() });
      return summary;
    } finally {
      inflight.delete(workingDir);
    }
  };
}

export interface DynamicContextOptions {
  readonly workingDir: string;
  readonly gitSummaryProvider?: GitSummaryProvider;
}

function getPlatformName(osPlatform: string): string {
  switch (osPlatform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return osPlatform;
  }
}

function getDefaultShell(osPlatform: string): string {
  if (osPlatform === 'win32') {
    return process.env['COMSPEC'] ?? 'powershell.exe';
  }
  return process.env['SHELL'] ?? '/bin/bash';
}

function formatGitStatus(summary: GitSummary): string {
  if (summary.clean) {
    return 'clean';
  }
  return `dirty (${summary.changedFiles} 个文件未提交)`;
}

const GIT_UNKNOWN: GitSummaryView = { branch: '非 git 仓库', status: '未知' };

async function collectGitSummary(
  provider: DynamicContextOptions['gitSummaryProvider'],
  workingDir: string,
): Promise<GitSummaryView> {
  if (provider === undefined) return GIT_UNKNOWN;
  try {
    const summary = await provider(workingDir);
    if (summary === null) return GIT_UNKNOWN;
    return { branch: summary.branch, status: formatGitStatus(summary) };
  } catch {
    return GIT_UNKNOWN;
  }
}

export async function injectDynamicContext(
  template: string,
  options: DynamicContextOptions,
): Promise<string> {
  const osPlatform = platform();
  const platformName = getPlatformName(osPlatform);
  const shell = getDefaultShell(osPlatform);
  const workingDir = resolve(options.workingDir);

  const { branch: gitBranch, status: gitStatus } = await collectGitSummary(
    options.gitSummaryProvider,
    workingDir,
  );

  let agentsMd = '';
  try {
    agentsMd = resolveAgentsMd(workingDir);
  } catch {}

  const values: Record<string, string> = {
    workingDir,
    os: osPlatform,
    platform: platformName,
    shell,
    gitBranch,
    gitStatus,
    agentsMd,
    homeDir: homedir(),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder: string, key: string) => {
    const value = values[key];
    return value ?? placeholder;
  });
}
