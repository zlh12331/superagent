// src/main/infra/memory-hub/capture-wire.ts
// 回合结束自动捕获：监听 AgentService 回合事件，把每轮对话写入 MemoryHub L0
// ──────────────────────────────────────────────────────────────
// 设计：
// - 助手文本：TEXT_DELTA 逐段累积（TURN_START 重置缓冲）
// - 用户文本：handler 在 run 前经 noteLastUser 注入（事件本身不携带消息文本）
// - TURN_END(completed) 时一次性 capture；失败静默降级（adapter 已兜底）
// - 只订阅不修改 AgentService 内部（零侵入）
// ──────────────────────────────────────────────────────────────

import type { TurnEvent } from '@code-agent/shared/main';
import type { IAgentService } from '../ai/agent/agent-service';
import { isMemoryEnabled } from './memory-pref';
import type { MemoryPort } from './types';

/** 从渲染层消息线程中提取最后一条用户文本（容错解析，兼容 UIMessage parts 形状） */
export function extractLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; parts?: unknown; content?: unknown };
    if (msg?.role !== 'user') continue;
    if (typeof msg.parts === 'string') return msg.parts;
    if (Array.isArray(msg.parts)) {
      const texts = msg.parts
        .map((p) =>
          typeof p === 'object' && p !== null ? (p as { text?: unknown }).text : undefined,
        )
        .filter((t): t is string => typeof t === 'string');
      const joined = texts.join('\n').trim();
      if (joined.length > 0) return joined;
    }
    if (typeof msg.content === 'string' && msg.content.trim().length > 0) {
      return msg.content;
    }
    return '';
  }
  return '';
}

/** 捕获接线实例 */
export interface MemoryCaptureWire {
  /** handler 在发起 run 前注入本轮用户输入（供 TURN_END 捕获使用） */
  noteLastUser(sessionId: string, text: string): void;
  /** 解除回合订阅 */
  unmount(): void;
}

/**
 * 创建回合捕获接线（幂等挂载一次 onTurnEvent）
 */
export function createMemoryCaptureWire(deps: {
  agentService: IAgentService;
  port: MemoryPort;
}): MemoryCaptureWire {
  const { agentService, port } = deps;
  const lastUserBySession = new Map<string, string>();
  const assistantBuffer = new Map<string, string>();

  const unsubscribe = agentService.onTurnEvent((event: TurnEvent) => {
    switch (event.type) {
      case 'turn-start':
        assistantBuffer.set(event.sessionId, '');
        break;
      case 'text-delta':
        assistantBuffer.set(
          event.sessionId,
          (assistantBuffer.get(event.sessionId) ?? '') + event.text,
        );
        break;
      case 'turn-end':
        // 用户开关关闭时不捕获新记忆（已记录的数据保留，可在设置页清除）
        if (event.reason === 'completed' && isMemoryEnabled()) {
          void port
            .capture({
              sessionKey: event.sessionId,
              userContent: lastUserBySession.get(event.sessionId) ?? '',
              assistantContent: assistantBuffer.get(event.sessionId) ?? '',
            })
            .catch(() => {});
        }
        assistantBuffer.delete(event.sessionId);
        break;
      default:
        break;
    }
  });

  return {
    noteLastUser(sessionId, text) {
      if (text.trim().length > 0) {
        lastUserBySession.set(sessionId, text.trim());
      }
    },
    unmount() {
      unsubscribe();
      lastUserBySession.clear();
      assistantBuffer.clear();
    },
  };
}
