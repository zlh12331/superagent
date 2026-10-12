// stream-part-forward.ts：流 part 转发到渲染层——text-delta 合批削峰、工具 part 输出按窗口夹紧
import type { AgentStreamPartPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';

import { emitEvent } from '../../../utils/emit-event';
import { createTextDeltaBatcher } from '../agent-runtime/text-delta-batcher';
import { clampToolPartOutput } from '../tools/tool-executor';

/** 转发单个流 part（无目标 webContents/已销毁静默丢弃；tool part 先按上下文窗口夹紧输出体） */
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
