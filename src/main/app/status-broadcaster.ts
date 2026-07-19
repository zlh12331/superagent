// src/main/app/status-broadcaster.ts
// 状态广播器：订阅 PG / Ollama 状态变更，广播到所有 BrowserWindow
//
// 职责：
// 1. 订阅 pgController 的 'status-change' 事件 → 广播 app:event:pgStatus
// 2. 订阅 ollamaController 的 'status-change' 事件 → 广播 app:event:ollamaStatus
// 3. 订阅 ollamaController 的 'pull-progress' 事件 → 广播 app:event:ollamaPullProgress
//
// 广播方式：BrowserWindow.getAllWindows().forEach(win => win.webContents.send(...))
// 已销毁窗口自动跳过，避免 isDestroyed() 异常
// 设计文档 §5.3 状态变更事件（M→R）

import { IPC_CHANNELS, type OllamaPullProgressPayload } from '@novel-writer/shared';
import { BrowserWindow } from 'electron';
import { getOllamaController } from '../infra/ai/ollama-controller';
import { logger } from '../utils/logger';
import { getPgController } from './db-init';

/** 广播状态标记，防止重复启动 */
let broadcasterStarted = false;

/**
 * 广播事件到所有渲染窗口
 *
 * 遍历所有 BrowserWindow，跳过已销毁的窗口。
 *
 * @param channel IPC 事件 channel 名
 * @param payload 事件 payload
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * 启动状态广播器
 *
 * 订阅 PG / Ollama 状态变更事件，广播到所有渲染窗口。
 * 幂等：多次调用安全（broadcasterStarted 标记防止重复注册 listener）。
 *
 * 调用时机：app.whenReady() 后、数据库初始化完成后（确保 getPgController() 非 null）。
 */
export function startStatusBroadcaster(): void {
  if (broadcasterStarted) {
    logger.warn({}, '状态广播器已启动，跳过重复初始化');
    return;
  }
  broadcasterStarted = true;

  // 1. PG 状态变更 → 广播 app:event:pgStatus
  const pg = getPgController();
  if (pg !== null) {
    pg.on('status-change', (event) => {
      logger.debug({ status: event.status }, 'PG 状态变更，广播到渲染层');
      broadcast(IPC_CHANNELS.APP_EVENT_PG_STATUS, event.status);
    });
  } else {
    logger.warn({}, 'PgController 未初始化，跳过 PG 状态广播');
  }

  // 2. Ollama 状态变更 → 广播 app:event:ollamaStatus
  const ollama = getOllamaController();
  ollama.on('status-change', (event) => {
    logger.debug({ status: event.status }, 'Ollama 状态变更，广播到渲染层');
    broadcast(IPC_CHANNELS.APP_EVENT_OLLAMA_STATUS, event.status);
  });

  // 3. Ollama 模型拉取进度 → 广播 app:event:ollamaPullProgress
  ollama.on('pull-progress', (event) => {
    const total = event.total ?? 0;
    const completed = event.completed ?? 0;
    const payload: OllamaPullProgressPayload = {
      model: ollama.getEmbedModel(),
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
    broadcast(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS, payload);
  });

  logger.info({}, '状态广播器已启动');
}

/**
 * 重置状态广播器（仅测试用）
 *
 * 重置 broadcasterStarted 标记，允许重新启动。
 * 注意：不会移除已注册的 listener（EventEmitter 生命周期由各自控制器管理）。
 */
export function resetStatusBroadcaster(): void {
  broadcasterStarted = false;
}
