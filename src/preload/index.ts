// src/preload/index.ts
// Preload 脚本：在隔离的 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §4.7 traceId 注入
//
// Phase 1 仅暴露空 api 占位，后续 Phase 将填充 project/chapter/chat 等

import { contextBridge } from 'electron';

// 暴露到渲染层的 window.api 命名空间（当前为空对象）
const api = {
  // Phase 2 起将逐步填充：
  // project: { ... }
  // chapter: { ... }
  // chat: { ... }
  // rag: { ... }
} as const;

// 通过 contextBridge 暴露（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
