// src/main/infra/ai/prompt/dynamic-context.ts
// 动态上下文注入器：在运行时把环境信息注入 System Prompt 模板
// ──────────────────────────────────────────────────────────────
// 职责：
// - 收集环境信息（OS / Shell / 工作目录）
// - 收集 Git 状态（分支 / 是否 clean / 未提交文件数）
// - 收集 AGENTS.md 内容（通过 agents-md.ts 分层发现）
// - 把模板变量 {{workingDir}} / {{os}} / {{gitBranch}} 等替换为实际值
//
// 设计原则：
// - 纯函数：注入器本身不持有状态，每次调用都重新收集
// - 失败容忍：任何一项收集失败（如非 git 仓库、无 AGENTS.md）都用占位符而非抛错
// - 性能：Git 状态查询可能涉及子进程 spawn，但通常 <100ms
// ──────────────────────────────────────────────────────────────

import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { resolveAgentsMd } from './agents-md';

/**
 * Git 状态摘要（简化版，仅用于 prompt 注入）
 */
interface GitSummary {
  /** 当前分支名 */
  readonly branch: string;
  /** 工作区是否干净 */
  readonly clean: boolean;
  /** 未提交文件数（含 staged + unstaged） */
  readonly changedFiles: number;
}

/** 注入 prompt 的 git 摘要视图（分支名 + 可读状态串） */
interface GitSummaryView {
  readonly branch: string;
  readonly status: string;
}

/**
 * Git 状态查询函数签名
 *
 * 注入而非直接依赖 GitService：
 * - 解耦 PromptService 对具体 GitService 实现的依赖
 * - 便于测试 mock（避免真实 git CLI 调用）
 *
 * @param workingDir 工作目录
 * @returns GitSummary；非 git 仓库返回 null
 */
export type GitSummaryProvider = (workingDir: string) => Promise<GitSummary | null>;

/**
 * 从「异步 git 状态查询」构造 GitSummaryProvider
 *
 * 只依赖查询的返回形状（branch / clean / files），不绑定具体 GitService
 * 实现。非 git 仓库等场景下查询抛错时向上传播，由
 * injectDynamicContext 捕获并回落为占位符。
 */
export function gitSummaryProviderFrom(
  getStatus: (workingDir: string) => Promise<{
    readonly branch: string;
    readonly clean: boolean;
    readonly files: readonly unknown[];
  }>,
): GitSummaryProvider {
  return async (workingDir) => {
    const status = await getStatus(workingDir);
    return { branch: status.branch, clean: status.clean, changedFiles: status.files.length };
  };
}

/**
 * 动态上下文注入选项
 */
export interface DynamicContextOptions {
  /** 工作目录绝对路径 */
  readonly workingDir: string;
  /**
   * Git 状态查询函数（可选）
   *
   * 不传则跳过 git 状态收集（prompt 中显示"未知"）
   */
  readonly gitSummaryProvider?: GitSummaryProvider;
}

/**
 * 获取平台描述
 *
 * node:os.platform() 返回 'darwin' / 'win32' / 'linux' 等，
 * 这里转换为用户友好的名称。
 */
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

/**
 * 获取默认 shell 名称
 *
 * Windows: PowerShell（或 cmd）
 * macOS/Linux: 从 SHELL 环境变量获取，默认 bash
 */
function getDefaultShell(osPlatform: string): string {
  if (osPlatform === 'win32') {
    // PowerShell 是 Windows 10+ 默认
    return process.env['COMSPEC'] ?? 'powershell.exe';
  }
  return process.env['SHELL'] ?? '/bin/bash';
}

/**
 * 把 git 状态格式化为人类可读摘要
 *
 * @param summary git 状态
 * @returns 如 "clean" 或 "dirty (3 个文件未提交)"
 */
function formatGitStatus(summary: GitSummary): string {
  if (summary.clean) {
    return 'clean';
  }
  return `dirty (${summary.changedFiles} 个文件未提交)`;
}

/** git 状态缺失时的占位摘要（provider 未注入 / 非仓库 / 查询失败） */
const GIT_UNKNOWN: GitSummaryView = { branch: '非 git 仓库', status: '未知' };

/**
 * 收集 git 分支与状态摘要
 *
 * 失败一律回退占位符而非抛错：prompt 注入不该因仓库查询中断。
 */
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

/**
 * 收集动态上下文并替换模板变量
 *
 * 流程：
 * 1. 收集环境信息（OS / Shell / 工作目录）
 * 2. 收集 Git 状态（通过 gitSummaryProvider，失败则显示"未知"）
 * 3. 收集 AGENTS.md（通过 resolveAgentsMd，无则空字符串）
 * 4. 替换模板中的 {{变量}} 占位符
 *
 * @param template 含 {{workingDir}} 等占位符的 prompt 模板
 * @param options 动态上下文选项
 * @returns 替换变量后的完整 prompt
 */
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

  // 收集 AGENTS.md（失败时用空字符串）
  let agentsMd = '';
  try {
    agentsMd = resolveAgentsMd(workingDir);
  } catch {
    // AGENTS.md 发现失败，用空字符串
  }

  // 替换模板变量：单次遍历 + 函数 replacer
  //   1) 函数 replacer：替换值里的 `$&` / `$1` / `$<name>` 不会被当作捕获组模式解释
  //      （workingDir / gitBranch / gitStatus / agentsMd 均来自仓库与文件系统，可含 `$`）
  //   2) 单次遍历：先插入的值（如 AGENTS.md 正文）里出现的 `{{homeDir}}` 字面量不会被二次替换
  //   未登记的占位符保持原样。
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
