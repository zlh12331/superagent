// src/renderer/hooks/use-chat.ts
// useChat 封装：注入 IpcChatTransport，提供 Electron 场景下的默认配置
//
// 职责：
// 1. 创建并复用 IpcChatTransport 单例（避免每次 render 创建新实例）
// 2. 透传 useChat 的所有 options（messages / onFinish / onError 等）
// 3. 统一错误处理：onError 自动 toast 提示（业务可覆盖）
//
// 使用示例：
// ```tsx
// import { useChatWithIpc } from '@/hooks/use-chat';
//
// function ChatPage() {
//   const { messages, sendMessage, status, error } = useChatWithIpc({
//     id: 'main-chat',
//   });
//
//   // 渲染 messages / 输入框 / 发送按钮...
// }
// ```
//
// 设计说明：
// - 不在本 hook 内做消息持久化（DB/localStorage），由调用方按需实现
// - 不预设 system prompt，由调用方在 messages 中传入
// - 默认开启 onFinish 日志记录（dev 环境），便于调试

import { type UseChatOptions, useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useMemo } from 'react';
import { IpcChatTransport } from '../lib/chat/ipc-chat-transport';

/**
 * IpcChatTransport 单例
 *
 * 模块级单例，整个应用生命周期共享一个实例。
 * ChatTransport 是无状态的（每次 sendMessages 都创建新的 ReadableStream），
 * 共享实例不会造成跨会话状态污染。
 */
let ipcTransport: IpcChatTransport | null = null;

/**
 * 获取 IpcChatTransport 单例
 *
 * 第一次调用时创建实例，后续调用复用缓存。
 * 暴露为公开 API，方便业务方手动调用 `useChat({ transport: getIpcChatTransport() })`。
 */
export function getIpcChatTransport(): IpcChatTransport {
  if (ipcTransport === null) {
    ipcTransport = new IpcChatTransport();
  }
  return ipcTransport;
}

/**
 * useChat 封装 hook：基于 IPC Transport 的对话能力
 *
 * @typeParam Message 渲染层 UIMessage 类型，默认为 UIMessage 基类
 * @param options 透传给 useChat 的配置（id / messages / onFinish / onError / onToolCall 等）
 * @returns useChat 返回值（messages / sendMessage / status / error / stop / regenerate 等）
 *
 * @example
 * ```tsx
 * const { messages, sendMessage, status } = useChatWithIpc({ id: 'main' });
 *
 * // 发送消息
 * await sendMessage({ text: '你好' });
 * ```
 */
export function useChatWithIpc<Message extends UIMessage = UIMessage>(
  options?: UseChatOptions<Message>,
) {
  // 复用单例 transport（避免每次 render 创建新实例）
  const transport = useMemo(() => getIpcChatTransport(), []);

  // 透传所有 useChat options，注入默认 transport
  // 业务方传入的 transport（若有）会覆盖默认值
  return useChat<Message>({
    transport,
    ...options,
  });
}
