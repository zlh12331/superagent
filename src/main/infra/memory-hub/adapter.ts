// adapter.ts：记忆引擎 HTTP 协议适配——全仓唯一知晓上游 gateway 请求/响应形状的文件
// ⚠️ 上游字段是 snake_case（协议面）；本文件转成 camelCase 端口对象，改协议先改这里
import { logger } from '../../utils/logger';
import type {
  MemoryCaptureInput,
  MemoryCaptureResult,
  MemoryClearResult,
  MemoryConversationSearchResult,
  MemoryPort,
  MemoryRecallInput,
  MemoryRecallResult,
  MemorySearchResult,
} from './types';

// 单请求 8s 超时：记忆调用不能拖住回合主流程
const REQUEST_TIMEOUT_MS = 8000;

/** HTTP 端口配置（baseUrl 已含 token 鉴权路径语义，apiKey 走 Bearer） */
export interface HttpMemoryPortOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** 引擎 HTTP 端口实现（MemoryPort 的协议侧；每个方法自带降级——失败返回空/假值不抛） */
export class HttpMemoryPort implements MemoryPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: HttpMemoryPortOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult> {
    try {
      const body = {
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        user_content: input.userContent,
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        assistant_content: input.assistantContent,
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        session_key: input.sessionKey,
      };
      const data = (await this.requestJson('POST', '/capture', body)) as {
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        l0_recorded?: number;
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        scheduler_notified?: boolean;
      };
      return {
        l0Recorded: typeof data['l0_recorded'] === 'number' ? data['l0_recorded'] : 0,
        schedulerNotified: data['scheduler_notified'] === true,
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        '[memory-hub] capture 失败（降级为不记录，不影响回合）',
      );
      return { l0Recorded: 0, schedulerNotified: false };
    }
  }

  async recall(input: MemoryRecallInput): Promise<MemoryRecallResult> {
    try {
      const body: Record<string, unknown> = { query: input.query };
      if (input.sessionKey !== undefined) {
        body['session_key'] = input.sessionKey;
      }
      const data = (await this.requestJson('POST', '/recall', body)) as {
        context?: string;
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        memory_count?: number;
        code?: number;
        message?: string;
      };
      if (typeof data.code === 'number' && data.code !== 0) {
        return {
          ok: false,
          context: '',
          memoryCount: 0,
          message: data.message ?? `code=${data.code}`,
        };
      }
      return {
        ok: true,
        context: data.context ?? '',
        memoryCount: typeof data['memory_count'] === 'number' ? data['memory_count'] : 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, '[memory-hub] recall 失败（返回空上下文）');
      return { ok: false, context: '', memoryCount: 0, message };
    }
  }

  async searchMemories(query: string, limit?: number): Promise<MemorySearchResult> {
    try {
      const body: Record<string, unknown> = { query };
      if (limit !== undefined) {
        body['limit'] = limit;
      }
      const data = (await this.requestJson('POST', '/search/memories', body)) as {
        results?: string;
        total?: number;
      };
      return {
        content: data.results ?? '',
        total: typeof data.total === 'number' ? data.total : 0,
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        '[memory-hub] searchMemories 失败',
      );
      return { content: '', total: 0 };
    }
  }

  async searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<MemoryConversationSearchResult> {
    try {
      const body: Record<string, unknown> = { query };
      if (limit !== undefined) {
        body['limit'] = limit;
      }
      if (sessionKey !== undefined) {
        body['session_key'] = sessionKey;
      }
      const data = (await this.requestJson('POST', '/search/conversations', body)) as {
        results?: string;
        total?: number;
      };
      return {
        content: data.results ?? '',
        total: typeof data.total === 'number' ? data.total : 0,
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        '[memory-hub] searchConversations 失败',
      );
      return { content: '', total: 0 };
    }
  }

  async clear(sessionKey: string): Promise<MemoryClearResult> {
    try {
      const data = (await this.requestJson('POST', '/v2/conversation/delete', {
        // biome-ignore lint/style/useNamingConvention: 上游 gateway 协议字段（snake_case）
        session_ids: [sessionKey],
      })) as {
        code?: number;
        message?: string;
        data?: {
          // biome-ignore lint/style/useNamingConvention: 上游 v2 envelope 协议字段（snake_case）
          deleted_count?: number;
        };
      };
      if (typeof data.code === 'number' && data.code !== 0) {
        return {
          ok: false,
          deletedCount: 0,
          message: data.message ?? `code=${data.code}`,
        };
      }
      const deletedCount =
        typeof data.data?.deleted_count === 'number' ? data.data.deleted_count : 0;
      return { ok: true, deletedCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message, sessionKey }, '[memory-hub] clear 失败（返回 ok=false）');
      return { ok: false, deletedCount: 0, message };
    }
  }

  private async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      throw new Error(`gateway ${method} ${path} -> ${res.status}`);
    }
    return (await res.json()) as unknown;
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
      Authorization: `Bearer ${this.apiKey}`,
      'x-tdai-service-id': 'default',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    return fetch(
      `${this.baseUrl}${path}`,
      body === undefined
        ? { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
        : {
            method,
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
    );
  }
}
