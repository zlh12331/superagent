// types.ts：记忆端口契约——宿主与引擎之间全部交互的接口（adapter 与空实现各自满足）
export interface MemoryCaptureInput {
  readonly sessionKey: string;
  readonly userContent: string;
  readonly assistantContent: string;
}

export interface MemoryCaptureResult {
  readonly l0Recorded: number;
  readonly schedulerNotified: boolean;
}

export interface MemoryRecallInput {
  readonly query: string;
  readonly sessionKey?: string;
}

export interface MemoryRecallResult {
  readonly ok: boolean;
  readonly context: string;
  readonly memoryCount: number;
  readonly message?: string;
}

export interface MemorySearchResult {
  readonly content: string;
  readonly total: number;
}

export interface MemoryConversationSearchResult {
  readonly content: string;
  readonly total: number;
}

export interface MemoryClearResult {
  readonly ok: boolean;
  readonly deletedCount: number;
  readonly message?: string;
}

/** 记忆端口（唯一交互面）：健康/捕获/召回/两类搜索/清除 */
export interface MemoryPort {
  health(): Promise<boolean>;
  capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult>;
  recall(input: MemoryRecallInput): Promise<MemoryRecallResult>;
  searchMemories(query: string, limit?: number): Promise<MemorySearchResult>;
  searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<MemoryConversationSearchResult>;
  clear(sessionKey: string): Promise<MemoryClearResult>;
}
