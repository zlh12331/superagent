// capture-wire.ts：回合事件 → 记忆捕获的接线——缓冲本回合用户/助手文本，TURN_END 时成对送引擎
import type { TurnEvent } from '@code-agent/shared/main';
import type { IAgentService } from '../ai/agent/agent-service';
import { isMemoryEnabled } from './memory-pref';
import type { MemoryPort } from './types';

/** 提取消息列表中最后一条用户文本（parts 数组/string/content 三形态兼容；IPC 输入校验用） */
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

/** 捕获接线句柄：noteLastUser 由 agent IPC 显式喂首条输入，unmount 摘事件订阅 */
export interface MemoryCaptureWire {
  noteLastUser(sessionId: string, text: string): void;
  unmount(): void;
}

/** 挂载捕获接线（index.ts 装配；capture 失败静默——审计镜像缺失不伤主流程） */
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
