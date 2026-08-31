// src/main/infra/storage/session-types.ts
// SessionService 契约层（自 session-service.ts 提取：接口与导出类型单一归属）
// ──────────────────────────────────────────────────────────────
// 职责：ISessionService 接口 + 入参/导出 payload 类型 + 标题常量。
// session-service.ts 对外 re-export 本文件全部符号（外部 import 路径不变）。
// ──────────────────────────────────────────────────────────────

import type {
  ChatMessage,
  SessionDeleteRes,
  SessionGetRes,
  SessionGetTurnsRes,
  SessionListRecentDirsRes,
  SessionListRes,
  SessionMeta,
  SessionPinRes,
  SessionRecentTurnsRes,
  SessionRenameRes,
  UsageSummaryRes,
} from '@code-agent/shared/main';

/**
 * create 方法入参
 *
 * 设计：title 与 initialMessages 均为可选，由调用方决定是否在创建时就写入消息。
 * - AgentService.startAgent 流结束后调用 create 持久化（仅传入 messages，title 自动生成）
 * - 渲染层若需要"先创建空会话再发消息"模式，可省略 initialMessages
 */
export interface SessionCreateOptions {
  /**
   * 项目工作目录（绝对路径，必填）
   *
   * 限制 agent 工具操作的根目录，每个会话绑定独立 workingDir。
   */
  readonly workingDir: string;
  /**
   * 可选标题
   *
   * 省略时自动生成：取首条 user 消息内容前 50 字符；无 user 消息则用 '新会话'。
   */
  readonly title: string | undefined;
  /**
   * 初始消息历史（可选）
   *
   * 通常为 AgentService.startAgent 收到的完整 messages 数组。
   * 省略时创建空会话，后续通过 appendMessage 追加。
   */
  readonly messages: readonly ChatMessage[] | undefined;
}

/**
 * appendMessage 方法入参
 */
export interface SessionAppendMessageOptions {
  /** 目标会话 id */
  readonly sessionId: string;
  /** 要追加的消息数组（按顺序写入，seq 自动递增） */
  readonly messages: readonly ChatMessage[];
  /** 归属回合 id（Transcript 消息级明细；省略 = 不归属） */
  readonly turnId?: string;
}

/**
 * 导出单个会话（元数据 + 消息历史）
 */
export interface SessionExportItem {
  readonly meta: SessionMeta;
  readonly messages: readonly unknown[];
}

/**
 * 导出全部会话的 payload（数据资产可迁移格式）
 */
export interface SessionExportPayload {
  readonly exportedAt: number;
  readonly app: string;
  readonly sessions: readonly SessionExportItem[];
}

/**
 * SessionService 接口
 *
 * 解耦 IPC handler 对具体类的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 SQLite
 * - 未来扩展：替换为 Postgres / IndexedDB 等其他存储后端
 *
 * 三组方法：
 * 1. IPC 暴露（list/get/delete/rename/pin）：渲染层通过 IPC 调用
 * 2. 内部 API（create/appendMessage/replaceMessages）：AgentService / ChatService 调用
 * 3. 用量与回合（recordUsage/getUsageSummary/recordTurn/...）：委托 usage-turn-store
 */
// biome-ignore lint/style/useNamingConvention: I 前缀接口为项目既有命名约定（ISessionService 全仓 26 处引用）
export interface ISessionService {
  // ── IPC 暴露方法 ───────────────────────────────────

  /** 分页列出所有会话（按 updatedAt 倒序） */
  list(limit: number, offset: number): Promise<SessionListRes>;
  /** 获取指定会话的完整消息历史 */
  get(id: string): Promise<SessionGetRes>;
  /** 删除指定会话（连同 messages 表级联删除） */
  delete(id: string): Promise<SessionDeleteRes>;
  /** 重命名会话标题 */
  rename(id: string, title: string): Promise<SessionRenameRes>;
  /** 置顶/取消置顶会话（对齐参考项目 pinned-header 分组） */
  pin(id: string, pinned: boolean): Promise<SessionPinRes>;

  // ── 内部 API（供 AgentService / ChatService 调用） ────

  /** 创建新会话（可选写入初始消息历史），返回 sessionId */
  create(options: SessionCreateOptions): Promise<string>;
  /** 向指定会话追加消息（seq 自动递增），返回追加后的消息总数 */
  appendMessage(options: SessionAppendMessageOptions): Promise<number>;
  /**
   * 整体替换会话消息历史（/compact 上下文压缩：删除全部行 → 重插压缩后消息），
   * 返回替换后的消息总数
   */
  replaceMessages(sessionId: string, newMessages: readonly ChatMessage[]): Promise<number>;

  /**
   * 查询指定回合的消息明细（Transcript 消息级回放）
   *
   * @param turnId 回合 id（turns.turn_id）
   * @returns 该回合的全部消息（按 seq 升序；无归属消息返回空数组）
   */
  getTurnMessages(turnId: string): Promise<ChatMessage[]>;

  /** 查询最近使用的目录列表（去重 + 按 lastUsed 倒序） */
  listRecentDirs(req: { readonly limit: number }): Promise<SessionListRecentDirsRes>;

  /**
   * 统计保留策略：删除用量统计窗口（90 天）外的 token_usage 行
   *
   * P2 修复：该表此前只写不删，重度使用一年可累积数十万行，
   * 库文件与备份轮转体积随之无限膨胀。窗口与 getUsageSummary 对齐，
   * 删除不改变统计语义。turns 表不在此列——它与回放/Transcript 结构绑定。
   */
  pruneExpiredUsage(): number;

  // ── 崩溃恢复（回合状态机） ──────────────────────────────

  /** 标记会话回合开始（崩溃恢复状态机） */
  markRunning(id: string): Promise<void>;
  /** 标记会话回合结束（正常结束/错误/中断都归位 idle） */
  markIdle(id: string): Promise<void>;
  /** 启动恢复：把所有 running 残留置为 interrupted，返回影响数 */
  markAllInterrupted(): Promise<number>;

  /** 导出全部会话（元数据 + 消息历史），数据资产可迁移 */
  exportAll(): Promise<SessionExportPayload>;

  // ── token 用量统计（设置页展示） ──────────────────────────

  /** 记录一次 LLM 调用用量（agent/chat 回合结束时写入一行） */
  recordUsage(usage: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number | undefined;
    readonly reasoningTokens: number | undefined;
  }): Promise<void>;
  /** 用量统计汇总（总量 / 按模型 / 按日） */
  getUsageSummary(): Promise<UsageSummaryRes>;

  // ── Transcript（回合记录，对齐 qwen chatRecordingService） ──────

  /** 记录一个回合（agent:run 结束后写入一行） */
  recordTurn(turn: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly modelId: string;
    readonly status: 'completed' | 'aborted' | 'max-steps' | 'error';
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
    readonly durationMs: number | undefined;
  }): Promise<void>;
  /** 查询会话的回合列表（按 seq 升序，Transcript 查询） */
  getTurns(sessionId: string): Promise<SessionGetTurnsRes>;
  /** 查询最近回合（跨会话，按 createdAt 倒序，设置页展示） */
  getRecentTurns(req: { readonly limit: number }): Promise<SessionRecentTurnsRes>;

  /** 优雅关闭（无外部资源，db 由 closeDb 在 ServiceContainer.dispose 中关闭） */
  dispose(): Promise<void>;
}

/**
 * 默认空会话标题
 *
 * 当传入 messages 中无 user 角色消息时使用。
 */
export const DEFAULT_SESSION_TITLE = '新会话';
