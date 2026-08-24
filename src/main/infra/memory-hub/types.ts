// src/main/infra/memory-hub/types.ts
// MemoryHub 记忆端口类型定义（本项目与上游 TencentDB-Agent-Memory 的唯一契约面）
// ──────────────────────────────────────────────────────────────
// 设计：
// - MemoryPort 是本项目对记忆引擎的抽象视图；上游 HTTP API 细节被 adapter 吸收，
//   其余模块（工具 / IPC / agent）只依赖本文件，不接触上游任何类型
// - 方法命名对齐上游语义：capture=L0 对话写入，recall=预取召回，searchMemories=L1 检索
// ──────────────────────────────────────────────────────────────

/** capture 入参（一轮对话的双向内容；L0 原样落盘） */
export interface MemoryCaptureInput {
  /** 会话键（映射上游 session_key；用本项目的 sessionId） */
  readonly sessionKey: string;
  /** 用户侧内容 */
  readonly userContent: string;
  /** 助手侧内容 */
  readonly assistantContent: string;
}

/** capture 结果 */
export interface MemoryCaptureResult {
  /** L0 实际落盘条数（0 = 引擎不可用或写入失败，不视为致命） */
  readonly l0Recorded: number;
  /** 蒸馏调度器是否已被通知 */
  readonly schedulerNotified: boolean;
}

/** recall 入参 */
export interface MemoryRecallInput {
  /** 召回查询（通常是本轮用户消息） */
  readonly query: string;
  /** 可选会话键（跨会话场景可省略） */
  readonly sessionKey?: string;
}

/** recall 结果（context 直接拼入 systemPrompt 之外的工具可见层；L0/L1 不进 prompt） */
export interface MemoryRecallResult {
  /** 是否成功（失败时 context 恒为空串） */
  readonly ok: boolean;
  /** 召回到的上下文文本（已由引擎格式化） */
  readonly context: string;
  /** 命中条数 */
  readonly memoryCount: number;
  /** 失败说明（ok=true 时省略） */
  readonly message?: string;
}

/** searchMemories 结果 */
export interface MemorySearchResult {
  /** 引擎格式化的检索结果文本 */
  readonly content: string;
  /** 命中总数 */
  readonly total: number;
}

/** searchConversations 结果（L0 会话内容检索，供设置页列表与兜底注入） */
export interface MemoryConversationSearchResult {
  /** 引擎格式化的检索结果文本 */
  readonly content: string;
  /** 命中总数 */
  readonly total: number;
}

/**
 * 记忆引擎端口（唯一边界接口）
 *
 * 全项目只允许 src/main/infra/memory-hub/ 内的实现接触上游；
 * 消费方（save_memory 工具 / memory IPC / 后续 agent 注入）仅依赖此接口。
 */
export interface MemoryPort {
  /** 引擎健康检查（sidecar 就绪探测也复用此实现） */
  health(): Promise<boolean>;
  /** 写入一轮对话（L0 落盘 + 异步蒸馏调度）；失败不抛错，返回 l0Recorded=0 */
  capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult>;
  /** 预取召回（keyword 策略，FTS5 BM25；embedding 未配置时不使用 hybrid） */
  recall(input: MemoryRecallInput): Promise<MemoryRecallResult>;
  /** L1 结构化记忆检索 */
  searchMemories(query: string, limit?: number): Promise<MemorySearchResult>;
  /** L0 会话内容检索（sessionKey 可选：命中后按会话过滤） */
  searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<MemoryConversationSearchResult>;
}
