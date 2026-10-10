import type { AgentStreamPartPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';

import { emitEvent } from '../../../utils/emit-event';
import { createTextDeltaBatcher } from '../agent-runtime/text-delta-batcher';
import { clampToolPartOutput } from '../tools/tool-executor';

export function forwardStreamPart(
  part: unknown,
  sessionId: string,
  webContents: WebContents | undefined,
  contextWindowSize?: number,
): void {
  if (webContents === undefined || webContents.isDestroyed()) {
    return;
  }
  const payload: AgentStreamPartPayload = {
    sessionId,
    part: clampToolPartOutput(part, contextWindowSize),
  };
  emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeStreamPart, payload);
}

export interface TurnPartForwarder {
  push(part: unknown): void;
  flush(): void;
}

export function createTurnPartForwarder(
  sessionId: string,
  webContents: WebContents | undefined,
  getContextWindowSize?: () => number | undefined,
): TurnPartForwarder {
  if (webContents === undefined) {
    return { push: () => {}, flush: () => {} };
  }
  const batcher = createTextDeltaBatcher({
    emit: (part) => forwardStreamPart(part, sessionId, webContents, getContextWindowSize?.()),
  });
  return { push: (part) => batcher.push(part), flush: () => batcher.flush() };
}
