import type { TurnEvent } from '@code-agent/shared/main';
import type { IAgentService } from '../ai/agent/agent-service';
import { isMemoryEnabled } from './memory-pref';
import type { MemoryPort } from './types';

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

export interface MemoryCaptureWire {
  noteLastUser(sessionId: string, text: string): void;
  unmount(): void;
}

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
