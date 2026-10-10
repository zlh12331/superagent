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
