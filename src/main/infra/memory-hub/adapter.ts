// src/main/infra/memory-hub/adapter.ts
// HttpMemoryPort：MemoryPort 的 HTTP 实现（对上游 gateway v1 数据面的薄封装）
// ──────────────────────────────────────────────────────────────
// 边界纪律：
// - 本文件是全项目唯一允许知晓上游 HTTP 细节（路径 / 鉴权头 / 响应形状）的模块
// - 上游 v1 端点返回裸 JSON（无 envelope）；鉴权 = Bearer + x-tdai-service-id
// - 所有调用带超时；capture/recall 失败降级为失败结果而非抛错（记忆故障不拖垮回合）
// ──────────────────────────────────────────────────────────────

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

/** 单次 HTTP 调用超时（毫秒） */
const REQUEST_TIMEOUT_MS = 8000;

/** HttpMemoryPort 构造选项 */
export interface HttpMemoryPortOptions {
  /** gateway 基地址（http://127.0.0.1:<port>） */
  readonly baseUrl: string;
  /** Bearer apiKey（与 sidecar 启动配置一致） */
  readonly apiKey: string;
}

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
      // 上游结构化失败信号：code 非 0 / 缺省视为成功
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
      // 上游 v2 envelope：成功 { code:0, message:'ok', data:{ deleted_count } }
      // 删除映射 l0_conversations.session_key = sessionId（capture 写入的字段）
      // 注意：不传 message_ids（空数组会触发 zod .min(1) 校验失败 → 400）
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

  /** 发起请求并解析裸 JSON（非 2xx 抛错） */
  private async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      throw new Error(`gateway ${method} ${path} -> ${res.status}`);
    }
    return (await res.json()) as unknown;
  }

  /** 底层 fetch（统一超时与鉴权头） */
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
