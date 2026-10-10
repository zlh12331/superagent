import type {
  ChatMessage,
  SessionClearAllRes,
  SessionDeleteRes,
  SessionExportFile,
  SessionExportItemShape,
  SessionGetRes,
  SessionGetTurnsRes,
  SessionImportRes,
  SessionListRecentDirsRes,
  SessionListRes,
  SessionPinRes,
  SessionRecentTurnsRes,
  SessionRenameRes,
  UsageSummaryRes,
} from '@code-agent/shared/main';

export interface SessionCreateOptions {
  readonly workingDir: string;
  readonly title: string | undefined;
  readonly messages: readonly ChatMessage[] | undefined;
}

export interface SessionAppendMessageOptions {
  readonly sessionId: string;
  readonly messages: readonly ChatMessage[];
  readonly turnId?: string;
}

export type SessionExportItem = SessionExportItemShape;

export type SessionExportPayload = SessionExportFile;

// biome-ignore lint/style/useNamingConvention: I 前缀接口为项目既有命名约定（ISessionService 全仓 26 处引用）
export interface ISessionService {
  list(limit: number, offset: number): Promise<SessionListRes>;
  get(id: string, options?: { includeMessages?: boolean }): Promise<SessionGetRes>;
  delete(id: string): Promise<SessionDeleteRes>;
  clearAll(): Promise<SessionClearAllRes>;
  rename(id: string, title: string): Promise<SessionRenameRes>;
  pin(id: string, pinned: boolean): Promise<SessionPinRes>;

  create(options: SessionCreateOptions): Promise<string>;
  appendMessage(options: SessionAppendMessageOptions): Promise<number>;
  replaceMessages(sessionId: string, newMessages: readonly ChatMessage[]): Promise<number>;

  getTurnMessages(turnId: string): Promise<ChatMessage[]>;

  listRecentDirs(req: { readonly limit: number }): Promise<SessionListRecentDirsRes>;

  pruneExpiredUsage(): number;

  markRunning(id: string): Promise<void>;
  markIdle(id: string): Promise<void>;
  markAllInterrupted(): Promise<number>;

  exportAll(): Promise<SessionExportPayload>;

  importAll(payload: unknown): Promise<SessionImportRes>;

  recordUsage(usage: {
    readonly sessionId: string;
    readonly modelId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number | undefined;
    readonly reasoningTokens: number | undefined;
  }): Promise<void>;
  getUsageSummary(): Promise<UsageSummaryRes>;

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
  getTurns(sessionId: string): Promise<SessionGetTurnsRes>;
  getRecentTurns(req: { readonly limit: number }): Promise<SessionRecentTurnsRes>;

  dispose(): Promise<void>;
}

export const DEFAULT_SESSION_TITLE = '新会话';
