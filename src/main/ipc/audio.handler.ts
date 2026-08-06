// src/main/ipc/audio.handler.ts
// 语音捕获 IPC handler（定义表驱动注册）
// ──────────────────────────────────────────────────────────────
// 职责：start（开录音）→ append（流式追加 PCM）→ stop（收尾返回 WAV 路径）
// 对应 shared 定义表 audio 域（meta.ts + definitions.ts 单一真源）
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { AudioCaptureService } from '../infra/audio/audio-capture-service';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 创建语音捕获 handlers
 *
 * @param service 录音服务（默认新建单实例——ServiceContainer 可注入复用）
 */
export function createAudioHandlers(
  service: AudioCaptureService = new AudioCaptureService(),
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['audio'] {
  return {
    start: async (input) => {
      const sessionId = service.start({
        ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
        ...(input.channels !== undefined ? { channels: input.channels } : {}),
      });
      return { sessionId };
    },

    append: async (input) => {
      service.appendChunk(input.chunk);
      return { received: input.chunk.byteLength };
    },

    stop: async (input) => {
      const result = service.stop();
      logger.info({ sessionId: input.sessionId, path: result.path }, '录音完成');
      return result;
    },
  };
}
