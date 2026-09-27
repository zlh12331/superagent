// src/renderer/lib/settings-ops.ts
// 设置域 IPC 桥（whitelist / tool / mcp / memory / skill / im / settings / update / session / app / browser）
// ──────────────────────────────────────────────────────────────
// 职责（direct-ipc 清迁，2026-09-26）：
// - settings 各 .tsx 面板此前直连 window.api.*，收敛到本文件（lib 层豁免）
// - 无桥（浏览器模式 / preload 缺失）的降级语义与原调用点逐一对齐：
//   查询返回空结果、订阅返回 no-op、写操作按原路径抛错或本地空操作
// - 不吞错误：IPC 错误响应经 unwrap 抛出（[CODE] 前缀），交调用方 onError/toast
// ──────────────────────────────────────────────────────────────

import type {
  ChannelListRes,
  ChannelOpRes,
  ExportDiagnosticsRes,
  LoginItemChangedPayload,
  LoginItemSettingsRes,
  MemoryClearAllRes,
  MemoryListRes,
  MemoryStatusRes,
  SessionImportRes,
  SessionRecentTurnsRes,
  SkillListRes,
  ToolListRes,
  UpdateCacheInfo,
  UsageSummaryRes,
  WhitelistAddRes,
  WhitelistListRes,
  WhitelistRemoveRes,
} from '@code-agent/shared/renderer';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** IM 渠道标识（ChannelListRes 条目的 kind） */
export type ImChannelKind = ChannelListRes['channels'][number]['kind'];

/**
 * MCP 服务器运行时信息（从 IPC 契约推导——renderer 出口不含 mcp schema，
 * 避免 zod 运行时进渲染层；与 mcp-section 原类型提取方式一致）
 */
export type McpServerInfo = Extract<
  Awaited<ReturnType<typeof window.api.mcp.list>>,
  { data: unknown }
>['data'] extends { servers: readonly (infer S)[] }
  ? S
  : never;

/** MCP 传输类型三态 */
export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

/** mcp:start 表单配置（组件组装后交给本模块展开为 IPC 入参） */
export interface McpStartConfig {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly headers?: Record<string, string>;
}

/** skill:learn 响应（定义表内联类型，此处镜像供组件使用） */
export interface SkillLearnResult {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly replaced: boolean;
}

/** skill:listLearned 条目 */
export interface LearnedSkillInfo {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

/** session:exportAll 响应 */
export interface SessionExportAllRes {
  readonly saved: boolean;
  readonly path?: string;
}

// ── whitelist / tool ──────────────────────────────────────────

/**
 * 列出命令白名单条目
 *
 * @returns 无桥时返回空列表（面板可渲染，只是无条目）
 */
export async function listWhitelistEntries(): Promise<WhitelistListRes> {
  if (!hasIpcBridge()) {
    return { entries: [] };
  }
  return unwrap(await window.api.whitelist.list());
}

/**
 * 添加白名单条目
 *
 * @returns 无桥时本地空操作（返回 ok: true，与原调用点一致——不误报失败）
 */
export async function addWhitelistEntry(entry: {
  readonly toolName: string;
  readonly pattern: string;
}): Promise<WhitelistAddRes> {
  if (!hasIpcBridge()) {
    return { ok: true };
  }
  return unwrap(await window.api.whitelist.add(entry));
}

/**
 * 移除白名单条目
 *
 * @returns 无桥时本地空操作（返回 ok: true）
 */
export async function removeWhitelistEntry(entry: {
  readonly toolName: string;
  readonly pattern: string;
}): Promise<WhitelistRemoveRes> {
  if (!hasIpcBridge()) {
    return { ok: true };
  }
  return unwrap(await window.api.whitelist.remove(entry));
}

/**
 * 列出已注册工具及权限级别
 *
 * @returns 无桥时返回空清单
 */
export async function listTools(): Promise<ToolListRes> {
  if (!hasIpcBridge()) {
    return { tools: [] };
  }
  return unwrap(await window.api.tool.list({ permission: undefined }));
}

// ── mcp ───────────────────────────────────────────────────────

/**
 * 列出 MCP 服务器
 *
 * @returns 无桥时返回空列表
 */
export async function listMcpServers(): Promise<{ servers: readonly McpServerInfo[] }> {
  if (!hasIpcBridge()) {
    return { servers: [] };
  }
  return unwrap(await window.api.mcp.list({}));
}

/**
 * 启动 MCP 服务器（表单配置 → IPC 入参展开）
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function startMcpServer(config: McpStartConfig): Promise<{ ok: boolean }> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(
    await window.api.mcp.start({
      name: config.name,
      ...(config.transport !== 'stdio' ? { transport: config.transport } : {}),
      ...(config.url !== undefined ? { url: config.url } : {}),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      command: config.command,
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
    }),
  );
}

/**
 * 停止 MCP 服务器
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function stopMcpServer(name: string): Promise<{ ok: boolean }> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.mcp.stop({ name }));
}

// ── memory ────────────────────────────────────────────────────

/**
 * 列出会话记忆条目
 *
 * @returns 无桥时返回空列表
 */
export async function listSessionMemories(sessionId: string): Promise<MemoryListRes> {
  if (!hasIpcBridge()) {
    return { memories: [] };
  }
  return unwrap(await window.api.memory.list({ sessionId }));
}

/**
 * 拉取记忆引擎状态
 *
 * @returns 无桥时返回 null（状态条不渲染）
 */
export async function getMemoryStatus(): Promise<MemoryStatusRes | null> {
  if (!hasIpcBridge()) {
    return null;
  }
  return unwrap(await window.api.memory.status({}));
}

/**
 * 清空会话记忆
 *
 * 主进程在引擎不可用时返回 `{ ok: false }`（不是 `{ error }`），
 * 因此必须显式检查 ok 并抛错，否则清除失败会被当作成功提示。
 *
 * @throws Error 无桥（[NO_BRIDGE]）、引擎不可用或 IPC 失败
 */
export async function clearSessionMemory(sessionId: string): Promise<void> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  const res = unwrap(await window.api.memory.clear({ sessionId }));
  if (!res.ok) {
    throw new Error('memory clear failed');
  }
}

/**
 * 清空全部记忆
 *
 * @throws Error 无桥（[NO_BRIDGE]）、引擎不可用或 IPC 失败
 */
export async function clearAllMemories(): Promise<{ clearedSessions: number }> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  const res: MemoryClearAllRes = unwrap(await window.api.memory.clearAll({}));
  if (!res.ok) {
    throw new Error(res.message ?? 'memory clear all failed');
  }
  return { clearedSessions: res.clearedSessions };
}

// ── skill ─────────────────────────────────────────────────────

/**
 * 列出全部可用技能（内置 + 已学）
 *
 * @returns 无桥时返回空列表
 */
export async function listSkills(): Promise<SkillListRes> {
  if (!hasIpcBridge()) {
    return { skills: [] };
  }
  return unwrap(await window.api.skill.list());
}

/**
 * 列出已学技能
 *
 * @returns 无桥时返回空列表
 */
export async function listLearnedSkills(): Promise<readonly LearnedSkillInfo[]> {
  if (!hasIpcBridge()) {
    return [];
  }
  return unwrap(await window.api.skill.listLearned());
}

/**
 * 学习新技能（LLM 生成结构化技能）
 *
 * @returns 无桥时返回空技能壳（本地空操作，与原调用点一致）
 */
export async function learnSkill(rawInput: string): Promise<SkillLearnResult> {
  if (!hasIpcBridge()) {
    return { name: '', description: '', prompt: '', replaced: false };
  }
  return unwrap(await window.api.skill.learn({ rawInput }));
}

/**
 * 移除已学技能
 *
 * @returns 无桥时返回 { removed: true }（本地空操作）
 */
export async function removeLearnedSkill(name: string): Promise<{ removed: boolean }> {
  if (!hasIpcBridge()) {
    return { removed: true };
  }
  return unwrap(await window.api.skill.removeLearned({ name }));
}

// ── im ────────────────────────────────────────────────────────

/**
 * 列出 IM 渠道
 *
 * @returns 无桥时返回空列表（面板可渲染，只是无渠道）
 */
export async function listImChannels(): Promise<ChannelListRes> {
  if (!hasIpcBridge()) {
    return { channels: [] };
  }
  return unwrap(await window.api.im.list());
}

/**
 * 启动 IM 渠道
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function startImChannel(params: {
  readonly kind: ImChannelKind;
  readonly token?: string;
}): Promise<ChannelOpRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(
    await window.api.im.start({
      kind: params.kind,
      ...(params.token !== undefined && params.token !== '' ? { token: params.token } : {}),
    }),
  );
}

/**
 * 停止 IM 渠道
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function stopImChannel(kind: ImChannelKind): Promise<ChannelOpRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.im.stop({ kind }));
}

// ── settings（IM 群聊白名单） ─────────────────────────────────

/** 群聊执行白名单的 settings key（与主进程 im-allowlist-pref 约定一致） */
export const IM_ALLOWED_GROUPS_SETTING_KEY = 'im.allowedGroups';

/**
 * 读取 IM 群聊执行白名单
 *
 * 不吞异常：读取失败必须区分于「真的是空白名单」。此前 catch 后 return []，
 * 使 UI 把失败渲染成空白名单，用户一保存就把服务端已登记的白名单覆盖清空。
 *
 * @returns 无桥时返回空列表
 */
export async function fetchImAllowedGroups(): Promise<readonly string[]> {
  if (!hasIpcBridge()) {
    return [];
  }
  const res = unwrap<{ settings: Record<string, unknown> }>(await window.api.settings.getAll({}));
  const raw = res.settings[IM_ALLOWED_GROUPS_SETTING_KEY];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 写入 IM 群聊执行白名单（覆盖式）
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function saveImAllowedGroups(groups: readonly string[]): Promise<void> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  unwrap(await window.api.settings.set({ key: IM_ALLOWED_GROUPS_SETTING_KEY, value: [...groups] }));
}

// ── update / session / app ────────────────────────────────────

/**
 * 拉取更新缓存占用
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败（调用方可 catch 静默）
 */
export async function getUpdateCacheInfo(): Promise<UpdateCacheInfo> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.update.getCacheInfo());
}

/**
 * 清理更新缓存
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function clearUpdateCache(): Promise<UpdateCacheInfo> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.update.clearCache());
}

/**
 * 导出全部会话
 *
 * @returns 无桥时视为用户取消（saved: false），调用方统一按取消分支静默处理
 */
export async function exportAllSessions(): Promise<SessionExportAllRes> {
  if (!hasIpcBridge()) {
    return { saved: false };
  }
  return unwrap(await window.api.session.exportAll());
}

/**
 * 导入会话（主进程 dialog 选文件 + 校验 + 落库）
 *
 * @returns 无桥时返回零计数（调用方按取消分支静默处理）
 */
export async function importAllSessions(): Promise<SessionImportRes> {
  if (!hasIpcBridge()) {
    return { imported: 0, skipped: 0 };
  }
  return unwrap(await window.api.session.importAll());
}

/**
 * 打开用户数据目录（返回主进程回读结果，供调用方区分成功/失败提示）
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败
 */
export async function openDataDirChecked(): Promise<{ ok: boolean }> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.app.openDataDir());
}

/**
 * 导出诊断包（构建/日志/系统信息）
 *
 * @returns 无桥时返回 null（调用方静默返回，不误报失败）
 */
export async function exportDiagnostics(): Promise<ExportDiagnosticsRes | null> {
  if (!hasIpcBridge()) {
    return null;
  }
  return unwrap(await window.api.app.exportDiagnostics());
}

// ── app 登录项（开机自启） ────────────────────────────────────

/**
 * 读取开机自启状态（OS 登录项为唯一真源）
 *
 * @throws Error 无桥（[NO_BRIDGE]）或 IPC 失败（调用方可 catch 后隐藏开关）
 */
export async function getLoginItemSettings(): Promise<LoginItemSettingsRes> {
  if (!hasIpcBridge()) {
    throw new Error('[NO_BRIDGE] window.api unavailable');
  }
  return unwrap(await window.api.app.getLoginItemSettings());
}

/**
 * 设置开机自启（响应是写入后回读的真实 OS 状态）
 *
 * @returns 无桥时返回 null（静默不操作，不误报失败）
 */
export async function setLoginItemSettings(params: {
  readonly openAtLogin: boolean;
}): Promise<LoginItemSettingsRes | null> {
  if (!hasIpcBridge()) {
    return null;
  }
  return unwrap(await window.api.app.setLoginItemSettings(params));
}

/**
 * 订阅开机自启状态变更（托盘菜单改动 → 设置页回显）
 *
 * @returns unsubscribe；无桥时返回 no-op
 */
export function subscribeLoginItemChanged(
  handler: (payload: LoginItemChangedPayload) => void,
): () => void {
  if (!hasIpcBridge()) {
    return () => {};
  }
  return window.api.app.subscribeLoginItemChanged(handler);
}

// ── session 用量 / 回合 ───────────────────────────────────────

/**
 * 拉取 Token 用量汇总
 *
 * @returns 无桥时返回 null（调用方渲染空数据骨架）
 */
export async function getUsageSummary(): Promise<UsageSummaryRes | null> {
  if (!hasIpcBridge()) {
    return null;
  }
  return unwrap(await window.api.session.getUsageSummary());
}

/**
 * 拉取最近 Agent 回合
 *
 * @returns 无桥时返回空回合列表
 */
export async function getRecentTurns(limit: number): Promise<SessionRecentTurnsRes['turns']> {
  if (!hasIpcBridge()) {
    return [];
  }
  return unwrap(await window.api.session.getRecentTurns({ limit })).turns;
}

// ── browser ───────────────────────────────────────────────────

/**
 * 应用浏览器预览配置（严格沙箱切换；主进程值一致时幂等 no-op）
 *
 * @returns 是否已发起（无桥 false，不抛错——调用方仅对 reject 提示）
 */
export function configureBrowser(params: { readonly strictSandbox: boolean }): Promise<boolean> {
  if (!hasIpcBridge()) {
    return Promise.resolve(false);
  }
  return window.api.browser.configure(params).then(() => true);
}
