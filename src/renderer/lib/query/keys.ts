// src/renderer/lib/query/keys.ts
// TanStack Query key 注册表（Query Key Factory 模式）
// ──────────────────────────────────────────────────────────────
// 为什么需要集中定义（2026-09-11）：
// - 原先「各域 hook 就近定义」在有域 hook 的场景已够用（use-sessions / use-git /
//   use-file-content 等），但**设置页各 section 与面板没有域 hook**，queryKey 直接
//   写在组件里；同时失效中枢 use-agent-bridge 只能用裸字面量（['task'] / ['git']…）。
//   一旦某处 key 形状变了，失效点**静默失配**——不报错、只是缓存不刷新。
// - 本模块是这些 key 的单一真源：查询点与失效点引用同一常量，形状漂移在编译期暴露。
//
// 约定：
// - 有域 hook 的域（sessions / git / file / models / api-key / remote / system /
//   telemetry）key 仍就近定义在各自 hook 内并 export，本模块不重复。
// - **没有域 hook** 的域（goal / task / skill / turns / usage / mcp / im / whitelist /
//   tool / memory）统一放这里；组件不得再内联 `queryKey: [...]` 字面量
//   （由 scripts/check-ui-consistency.ts 的 inline-query-key 规则看护）。
// ──────────────────────────────────────────────────────────────

/** 各域的 key 根前缀：用于**前缀失效**（invalidateQueries 匹配该域全部子 key） */
export const QUERY_KEY_ROOTS = {
  sessions: ['sessions'],
  session: ['session'],
  goal: ['goal'],
  task: ['task'],
  usage: ['usage'],
  git: ['git'],
  file: ['file'],
  turns: ['turns'],
} as const;

// ── 目标（goal）─────────────────────────────────────────────
/** 会话目标列表（GoalBar / 目标栏） */
export const GOAL_LIST_QUERY_KEY = (sessionId: string) => ['goal', 'list', sessionId] as const;

// ── 任务（task）─────────────────────────────────────────────
/** 会话待办列表（右面板 InfoPane；前缀失效用 QUERY_KEY_ROOTS.task） */
export const TASK_LIST_QUERY_KEY = (sessionId: string) => ['task', 'list', sessionId] as const;

// ── 技能（skill）────────────────────────────────────────────
/** 已学技能列表 */
export const LEARNED_SKILLS_QUERY_KEY = ['skill', 'learned'] as const;
/** 全部可用技能 */
export const ALL_SKILLS_QUERY_KEY = ['skill', 'all'] as const;

// ── 回合（turns）────────────────────────────────────────────
/** 最近回合记录（设置页展示） */
export const RECENT_TURNS_QUERY_KEY = ['turns', 'recent'] as const;

// ── 用量（usage）────────────────────────────────────────────
/** 用量汇总（真实数据源为主进程 SQLite 聚合，见 use-agent-bridge 的失效说明） */
export const USAGE_SUMMARY_QUERY_KEY = ['usage', 'summary'] as const;

// ── MCP ─────────────────────────────────────────────────────
/** MCP server 列表 */
export const MCP_SERVERS_QUERY_KEY = ['mcp', 'servers'] as const;

// ── IM 渠道 ─────────────────────────────────────────────────
/** IM 渠道列表 */
export const IM_CHANNELS_QUERY_KEY = ['im', 'channels'] as const;
/** 群聊执行白名单（settings 域，key 形如 'im.allowedGroups'） */
export const IM_ALLOWED_GROUPS_QUERY_KEY = (settingKey: string) =>
  ['settings', settingKey] as const;

// ── 审批模式 ─────────────────────────────────────────────────
/** 工具白名单条目 */
export const WHITELIST_ENTRIES_QUERY_KEY = ['whitelist', 'entries'] as const;
/** 全部工具列表 */
export const TOOLS_LIST_QUERY_KEY = ['tool', 'list'] as const;

// ── 记忆（memory）────────────────────────────────────────────
/** 会话记忆列表（按会话隔离） */
export const MEMORY_LIST_QUERY_KEY = (sessionId: string) => ['memory', 'list', sessionId] as const;
