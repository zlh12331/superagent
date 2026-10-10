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
  memory: ['memory'],
} as const;

/** 会话目标列表（GoalBar / 目标栏） */
export const GOAL_LIST_QUERY_KEY = (sessionId: string) => ['goal', 'list', sessionId] as const;

/** 会话待办列表（右面板 InfoPane；前缀失效用 QUERY_KEY_ROOTS.task） */
export const TASK_LIST_QUERY_KEY = (sessionId: string) => ['task', 'list', sessionId] as const;

/** 已学技能列表 */
export const LEARNED_SKILLS_QUERY_KEY = ['skill', 'learned'] as const;
/** 全部可用技能 */
export const ALL_SKILLS_QUERY_KEY = ['skill', 'all'] as const;

/** 最近回合记录（设置页展示） */
export const RECENT_TURNS_QUERY_KEY = ['turns', 'recent'] as const;

/** 用量汇总（真实数据源为主进程 SQLite 聚合，见 use-agent-bridge 的失效说明） */
export const USAGE_SUMMARY_QUERY_KEY = ['usage', 'summary'] as const;

/** MCP server 列表 */
export const MCP_SERVERS_QUERY_KEY = ['mcp', 'servers'] as const;

/** IM 渠道列表 */
export const IM_CHANNELS_QUERY_KEY = ['im', 'channels'] as const;
/** 群聊执行白名单（settings 域，key 形如 'im.allowedGroups'） */
export const IM_ALLOWED_GROUPS_QUERY_KEY = (settingKey: string) =>
  ['settings', settingKey] as const;

/** 工具白名单条目 */
export const WHITELIST_ENTRIES_QUERY_KEY = ['whitelist', 'entries'] as const;
/** 全部工具列表 */
export const TOOLS_LIST_QUERY_KEY = ['tool', 'list'] as const;

/** 会话记忆列表（按会话隔离） */
export const MEMORY_LIST_QUERY_KEY = (sessionId: string) => ['memory', 'list', sessionId] as const;
/** 引擎状态（配置/运行/健康/数据量 + 用户开关） */
export const MEMORY_STATUS_QUERY_KEY = ['memory', 'status'] as const;
