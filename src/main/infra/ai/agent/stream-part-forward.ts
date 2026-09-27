// src/main/infra/ai/agent/stream-part-forward.ts
// 流式 part 推送出口（2026-09-27 从 agent-service 提取，携带 P2-31 合帧装配）
// ──────────────────────────────────────────────────────────────
// - forwardStreamPart：单 part 推送（含输出闸门 clampToolPartOutput + dev 契约校验）
// - createTurnPartForwarder：回合级装配——text-delta 经 16–20ms 微批合帧（P2-31），
//   其余 part 透传；回合结束/错误路径在推送 END/ERROR 前调用 flush() 保序防丢尾。
// 提取理由：agent-service 体量在 file-size 棘轮基线内（net 683），本文件把
//   推送装配独立出去，新增合帧逻辑不再推高宿主文件。
// ──────────────────────────────────────────────────────────────

import type { AgentStreamPartPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';

import { emitEvent } from '../../../utils/emit-event';
import { createTextDeltaBatcher } from '../agent-runtime/text-delta-batcher';
import { clampToolPartOutput } from '../tools/tool-executor';

/**
 * 推送单个流式 part 到渲染层（2026-09-08 从 streamToWebContents 提取）
 *
 * 含输出闸门（此前只加在 tool-executor 的 tool-result 通道，本通道会原样
 * 透传 tool-output-available 的完整 output，read_file 可带 2MB → 约 50 万
 * token 进渲染层与后续上下文）。
 */
export function forwardStreamPart(
  part: unknown,
  sessionId: string,
  webContents: WebContents | undefined,
): void {
  if (webContents === undefined || webContents.isDestroyed()) {
    return;
  }
  const payload: AgentStreamPartPayload = {
    sessionId,
    part: clampToolPartOutput(part),
  };
  // dev 契约校验后发送（payloadSchema 见定义表）
  emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeStreamPart, payload);
}

/** 回合级 part 推送器：push 透传/合帧，flush 落地缓冲（END/ERROR 推送前调用） */
export interface TurnPartForwarder {
  /** 推入一个上游 part（text-delta 可能被合帧缓冲，其余立即透出） */
  push(part: unknown): void;
  /** 立即透出缓冲（幂等；回合收尾必须调用，防丢尾） */
  flush(): void;
}

/**
 * 装配回合级 part 推送器（P2-31）
 *
 * text-delta 按 sessionId 聚合微批合帧；无 webContents 的无头场景
 * （IM 桥接等）推送恒为 no-op，直接短路不引入缓冲开销。
 */
export function createTurnPartForwarder(
  sessionId: string,
  webContents: WebContents | undefined,
): TurnPartForwarder {
  if (webContents === undefined) {
    return { push: () => {}, flush: () => {} };
  }
  const batcher = createTextDeltaBatcher({
    emit: (part) => forwardStreamPart(part, sessionId, webContents),
  });
  return { push: (part) => batcher.push(part), flush: () => batcher.flush() };
}
