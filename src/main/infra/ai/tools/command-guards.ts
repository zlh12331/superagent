// src/main/infra/ai/tools/command-guards.ts
// 权限决策的确定性判定原语（纯函数，无状态、无 IPC 依赖）
//
// 从 permission-service.ts 抽出：这些判定是「字符串/路径层面的纯计算」，
// 与审批流（pending Promise、记忆缓存、webContents 推送）无关，独立成模块
// 便于单测直接覆盖边界用例，也让 PermissionService 专注决策编排。
//
// 包含三组判定：
// 1. 白名单模式语义：通用模式（空/通配符）识别 + token 级前缀匹配
// 2. 命令结构：复合命令识别 + 命令文本提取 + 路径越界识别
// 3. plan 模式控制面逃生舱名单

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { splitShellWords } from '../../terminal/terminal-service';
import { resolveRealTarget } from './path-guard';

/**
 * 「等同放行该工具全部调用」的白名单模式（P0 安全修复）
 *
 * 历史上 `pattern === ''` 被解释为「该工具无条件放行」，于是
 * - 设置页留空 pattern 点添加 = 给 write_file / run_command 开了免审批全局通道；
 * - 老版本持久化在 whitelist.json 里的空模式条目应用重启后继续静默生效。
 * 纯通配符（`*` / `**` / `.*` / `?` / 仅空白）语义上等价，一并视为无效条目。
 * 现在：插入时拒绝、加载时清理、匹配时永不命中（fail closed）。
 */
const UNIVERSAL_WHITELIST_PATTERN = /^[\s.*?]*$/;

/** 模式是否等同「放行该工具的全部调用」（空串 / 纯通配符 / 仅空白） */
export function isUniversalWhitelistPattern(pattern: string): boolean {
  return UNIVERSAL_WHITELIST_PATTERN.test(pattern);
}

/**
 * 白名单 token 级前缀匹配（P0 安全修复，替代任意位置 includes 子串）
 *
 * 规则：command.trim() 与 pattern 相等，或以 pattern 开头且紧随空白边界。
 * pattern='npm test'：命中 'npm test -- --watch'；
 * 不命中 'echo npm test'（前缀不符）、'npm testcase'（无词边界）。
 * 大小写敏感（与 shell 命令语义一致）。
 */
export function matchesWhitelistPattern(command: string, pattern: string): boolean {
  const normalized = command.trim();
  const pat = pattern.trim();
  if (normalized === pat) {
    return true;
  }
  return normalized.startsWith(pat) && /\s/.test(normalized.charAt(pat.length));
}

/**
 * 计划模式下仍然放行的 auto 控制面工具（P0 修复的显式逃生舱）
 *
 * plan 模式语义 = 只读探索，非只读的 auto 工具一律回落到模式判定（deny）。
 * 但下列工具改的是「agent 自己的记账/模式状态」，不触碰工作区与外部系统：
 * - enter_plan_mode / exit_plan_mode：若 exit_plan_mode 也被 deny，
 *   模型和用户都再也走不出计划模式（审批死锁）
 * - task_create / task_update / task_stop：计划期维护 todo 列表正是 plan 的用途
 * - save_memory：写记忆库，非工作区文件
 * 新增工具不在此列时按「非只读」处理（fail closed），需要放行就显式加名。
 */
export const PLAN_MODE_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'enter_plan_mode',
  'exit_plan_mode',
  'task_create',
  'task_update',
  'task_stop',
  'save_memory',
]);

/**
 * 复合命令特征（P0 安全修复）
 *
 * 含任一特征说明不是单一简单命令：`;' `|` `&` 串联/后台、反引号与 `$(`
 * 命令替换、换行续行、**重定向（`>` `>>` `<`）**。此类命令在两处被禁用快速通道
 * （安全方向保守）：
 * 1. 用户白名单不命中（isWhitelisted）——放行意图只针对单一命令
 * 2. SAFE_READ_ONLY 只读自动放行跳过——其 ^ 前缀锚定不覆盖后继段落
 * 引号内的误判（如 URL 查询串含 '&'）只会降级走完整决策链，不会放大权限。
 *
 * 重定向是 2026-09-08 安全审计修复：此前 `npm test > ~/.ssh/authorized_keys`
 * 命中白名单前缀（`npm test`）且不被视为复合命令，白名单分支又不做边界检查，
 * 于是模型可借重定向在边界外静默创建/覆盖文件。
 */
const COMPOSITE_COMMAND_PATTERN = /[;|&`<>]|\$\(|\n/;

/** 命令是否为复合结构（串联 / 管道 / 命令替换 / 换行） */
export function isCompositeCommand(command: string): boolean {
  return COMPOSITE_COMMAND_PATTERN.test(command);
}

/** Windows 盘符绝对路径（C:\ 或 C:/）；POSIX 根路径单独以 '/' 起判 */
const WIN_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

/**
 * P2 安全加固：判断命令是否引用了边界目录之外的路径目标。
 *
 * 判定保守：任何绝对路径 token（盘符 / POSIX 根 / ~ 展开）或解析后逃逸边界的
 * 相对路径（../ 链）都视为越界。命令分词复用 splitShellWords（跨平台引号/转义语义），
 * 仅对「像路径」的 token 判定——选项开关（如 --force）、URL 等不误伤。
 *
 * symlink 解析（2026-09-06 安全审计修复）：仅字符串级 relative 会被工作区内
 * `link -> ~/.ssh` 这类符号链接绕过（文件工具已由 path-guard 的 realpath 拦下，
 * 命令通道此前没有）。现在每个路径 token 先取真实落点（resolveRealTarget，
 * 不存在时回退最近存在祖先的 realpath）再比边界。
 */
export function commandTargetsOutsideBoundary(command: string, boundary: string): boolean {
  let tokens: string[];
  try {
    tokens = splitShellWords(command, process.platform);
  } catch {
    // 分词失败按越界处理（保守：交给 ask 分支人工确认）
    return true;
  }
  // 边界本身解析失败 → 无法判定，按越界处理（fail closed）
  const realBoundary = resolveRealTarget(normalize(boundary));
  if (realBoundary === null) {
    return true;
  }
  const normBoundary = realBoundary.toLowerCase();
  for (const raw of tokens) {
    if (!isPathLikeToken(raw)) continue;
    // 路径形状 token 含变量/参数展开 → 无法静态解析落点，fail closed
    // （2026-09-08 安全审计修复：`cat $HOME/.ssh/id_rsa` 此前被判为界内只读命令）
    if (isVariablePathToken(raw)) {
      return true;
    }
    let resolved: string;
    try {
      resolved = resolvePathToken(raw, boundary);
    } catch {
      return true;
    }
    // 真实落点：工作区内 symlink 指向边界外时，字符串级 relative 会误判为界内。
    // 解析失败（损坏/循环链接）同样按越界处理（fail closed）。
    const realTarget = resolveRealTarget(resolved);
    if (realTarget === null) {
      return true;
    }
    const rel = relative(normBoundary, realTarget.toLowerCase());
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/** URL 形状 token（跳过路径判定，避免把 curl 的网址误判为越界路径） */
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 含环境变量/参数展开的路径 token（2026-09-08 安全审计修复）
 *
 * `$HOME/.ssh/id_rsa`、`%USERPROFILE%\.aws\credentials`、`${HOME}/x`、`$HOME`
 * 这类 token 无法静态解析真实落点：此前 isPathLikeToken 因 token 含分隔符而判为
 * 「像路径」，resolvePathToken 却把 `$HOME` 当普通相对段拼到边界目录下，
 * 于是 `cat $HOME/.ssh/id_rsa` 被判定为「边界内 + 只读命令」而免审批执行——
 * 这是对 ~ 展开修复（2026-09-06）的直接绕过。
 *
 * 判定保持精确以免误伤：
 * - 具名环境变量（`$HOME` / `${HOME}` / `%USERPROFILE%`）→ 命中
 * - 位置参数 `$1` / `$@` / `$*` **不算**（脚本参数不是路径，`echo $1` 不应降级）
 * - 正则参数 `'^[a-z]+$'` 无分隔符且非纯变量形态 → 不命中
 */
const PURE_VARIABLE_TOKEN = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$/;
const VARIABLE_WITH_PATH = /\$\{?[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/;

/** token 是否为「纯变量」或「变量 + 路径分隔符」形态（落点不可静态解析） */
function isVariablePathToken(token: string): boolean {
  if (PURE_VARIABLE_TOKEN.test(token)) {
    return true;
  }
  return VARIABLE_WITH_PATH.test(token) && /[\\/]/.test(token);
}

/**
 * token 是否可能指向文件系统目标
 *
 * 绝对路径 / ~ 前缀 / 含 .. 段 / **含分隔符的相对路径**。
 * 最后一条是 2026-09-06 安全审计修复：此前普通相对路径（如 `cat link/secret.txt`）
 * 不被判定为路径 token，于是工作区内指向外部的 symlink 完全绕过了边界检查。
 */
function isPathLikeToken(token: string): boolean {
  if (WIN_ABSOLUTE_PATTERN.test(token) || token.startsWith('/') || token.startsWith('~')) {
    return true;
  }
  if (token === '..' || token.startsWith('../') || token.startsWith('..\\')) {
    return true;
  }
  if (URL_LIKE_PATTERN.test(token)) {
    return false;
  }
  // 变量形态（`ls $HOME` / `cat $HOME/.ssh/id_rsa`）：落点不可静态解析
  if (isVariablePathToken(token)) {
    return true;
  }
  return token.includes('/') || token.includes('\\');
}

/** 把路径 token 解析为绝对路径（~ → home；相对 → 相对边界） */
function resolvePathToken(token: string, boundary: string): string {
  if (token.startsWith('~')) {
    return resolve(join(homedir(), token.slice(1)));
  }
  if (WIN_ABSOLUTE_PATTERN.test(token) || token.startsWith('/')) {
    return normalize(token);
  }
  return resolve(boundary, token);
}

/**
 * plan 模式是否应拒绝该工具（2026-09-06 审计修复）
 *
 * 只读工具与控制面逃生舱放行，其余一律拒绝。**必须在记忆缓存 / 用户白名单之前判定**，
 * 否则 plan 模式下"曾被批准的同入参调用"或白名单工具仍会真实写文件 / 执行命令。
 */
export function isDeniedByPlanMode(
  mode: string,
  tool: { readonly name: string; readonly category: string },
): boolean {
  return mode === 'plan' && tool.category !== 'read' && !PLAN_MODE_CONTROL_TOOLS.has(tool.name);
}

/**
 * 从工具入参提取命令文本（run_command: { command }；terminal: { command? }）
 *
 * 无命令字段的工具入参返回 undefined（跳过命令级检测）。
 */
export function extractCommandFromInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const command = record['command'];
  return typeof command === 'string' && command.trim().length > 0 ? command : undefined;
}
