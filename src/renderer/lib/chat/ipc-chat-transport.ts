// src/renderer/lib/chat/ipc-chat-transport.ts
// 自定义 ChatTransport：把 useChat 与 Electron IPC 桥接
//
// 设计目标：
// 在 contextIsolation: true + sandbox: true 环境下，让 Vercel AI SDK 的 useChat
// 通过 window.api.chat IPC 与主进程通信，避免在主进程启动 HTTP server。
//
// 工作流程：
// 1. useChat 调用 transport.sendMessages({ messages, abortSignal, ... })
// 2. transport 把 UIMessage[] 转换为 ChatMessage[]（仅提取 role + text content）
// 3. transport 创建 ReadableStream<UIMessageChunk> 并：
//    a. 订阅 window.api.chat 的 part/end/error 三个 IPC 事件
//    b. 调用 window.api.chat.send() 触发主进程 streamText
//    c. 收到 part 事件时 enqueue 到 stream
//    d. 收到 end 事件时 close stream
//    e. 收到 error 事件时 error stream
//    f. abortSignal 触发时调用 window.api.chat.stop() 中断主进程
// 4. useChat 自动消费 ReadableStream，更新 messages 状态
//
// 安全说明：
// - 渲染层不直接调用 AI SDK，API key 留主进程
// - IPC channel 名由 shared 包常量提供，避免拼写错误
// - sessionId 用于过滤当前对话的事件（避免多窗口/多会话串流）
//
// 限制：
// - 不支持 reconnectToStream（主进程未持久化流状态，刷新页面无法恢复）
// - 仅支持纯文本对话（UIMessage.parts 中的 TextUIPart），tool/reasoning 暂不传递

import type { ChatMessage } from '@novel-writer/shared';
import {
  type ChatRequestOptions,
  type ChatTransport,
  isTextUIPart,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

/**
 * IpcChatTransport：Electron IPC 适配的 ChatTransport 实现
 *
 * 实现官方 ChatTransport 接口，桥接 useChat 与 window.api.chat IPC API。
 * 替代官方 DefaultChatTransport（HTTP POST）和 DirectChatTransport（同进程）。
 *
 * @typeParam Message 渲染层 UIMessage 类型，默认为 UIMessage 基类
 *
 * @example
 * ```tsx
 * import { useChat } from '@ai-sdk/react';
 * import { IpcChatTransport } from '@/lib/chat/ipc-chat-transport';
 *
 * const transport = new IpcChatTransport();
 * const { messages, sendMessage } = useChat({ transport });
 * ```
 */
export class IpcChatTransport<Message extends UIMessage = UIMessage>
  implements ChatTransport<Message>
{
  /**
   * 发送消息并返回流式响应
   *
   * 被 useChat 内部调用，传入当前消息历史 + abortSignal，
   * 返回一个 UIMessageChunk 流，useChat 自动消费并更新 messages 状态。
   *
   * 实现：
   * 1. 把 UIMessage[] 转换为 ChatMessage[]（仅提取 role + text content）
   * 2. 创建 ReadableStream，订阅 IPC 事件流式 enqueue chunk
   * 3. 调用 window.api.chat.send() 触发主进程 streamText
   * 4. abortSignal 触发时调用 window.api.chat.stop() 中断主进程
   */
  sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message';
      chatId: string;
      messageId: string | undefined;
      messages: Message[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    // 1. UIMessage[] → ChatMessage[]：仅提取 role + 拼接 text content
    // 不传 tool/reasoning part，主进程仅做纯文本 streamText
    const chatMessages: ChatMessage[] = options.messages.map((msg) => ({
      role: msg.role,
      content: extractTextContent(msg),
    }));

    // 2. 创建 ReadableStream，桥接 IPC 事件
    // 注意：currentSessionId 在 send() 返回后填充，初始为 undefined
    // 在此期间订阅的 IPC 事件会被过滤（不 enqueue），避免错位
    let currentSessionId: string | undefined;

    // 3. 收集所有 unsubscribe 函数，流结束/出错/中断时统一调用
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<UIMessageChunk>({
      async start(controller) {
        // 3a. 订阅三个 IPC 事件（按 sessionId 过滤）
        const offPart = window.api.chat.subscribePart(({ sessionId, part }) => {
          // 过滤其他 session 的事件（多窗口/多会话场景下可能收到交叉事件）
          if (sessionId !== currentSessionId) {
            return;
          }
          // part 类型在 shared 中为 unknown（避免 shared 依赖 ai 包），
          // 此处断言为 UIMessageChunk，因为主进程推送的即为此类型
          controller.enqueue(part as UIMessageChunk);
        });

        const offEnd = window.api.chat.subscribeEnd(({ sessionId }) => {
          if (sessionId !== currentSessionId) {
            return;
          }
          // 正常结束：关闭 stream + 清理订阅
          cleanup?.();
          controller.close();
        });

        const offError = window.api.chat.subscribeError(({ sessionId, code, message }) => {
          if (sessionId !== currentSessionId) {
            return;
          }
          // 异常结束：以 error 关闭 stream + 清理订阅
          // useChat 会把 error 写入 status='error'，渲染层可读取并展示
          cleanup?.();
          controller.error(new Error(`[${code}] ${message}`));
        });

        // 3b. 统一清理函数：移除所有 IPC 订阅
        cleanup = () => {
          offPart();
          offEnd();
          offError();
        };

        // 3c. abortSignal 处理：用户点击 stop 按钮时触发
        // 调用 window.api.chat.stop() 让主进程中断 streamText，
        // 主进程感知 abort 后会推送 CHAT_STREAM_END（不推送 error，视为正常中断）
        if (options.abortSignal !== undefined) {
          options.abortSignal.addEventListener(
            'abort',
            () => {
              if (currentSessionId !== undefined) {
                // 异步触发中断，不 await（避免阻塞 abort 回调）
                void window.api.chat.stop({ sessionId: currentSessionId });
              }
            },
            { once: true },
          );
        }

        // 4. 触发主进程 streamText（异步推送 part）
        const response = await window.api.chat.send({
          messages: chatMessages,
          // 当前实现：每次 sendMessages 都视为新会话（sessionId: undefined）
          // 主进程会生成新 sessionId 并通过 IPC 推送 part
          // 未来若要支持会话续传（保留主进程上下文），可改为传入 options.chatId
          sessionId: undefined,
        });

        // 5. 处理响应：失败则 error stream，成功则记录 sessionId
        if ('error' in response && response.error !== undefined) {
          cleanup?.();
          controller.error(new Error(`[${response.error.code}] ${response.error.message}`));
          return;
        }
        if ('data' in response && response.data !== undefined) {
          currentSessionId = response.data.sessionId;
        }
      },
      // cancel：流被 useChat 主动取消（如组件卸载）时触发
      // 清理 IPC 订阅 + 中断主进程（若有活跃 sessionId）
      cancel() {
        cleanup?.();
        if (currentSessionId !== undefined) {
          void window.api.chat.stop({ sessionId: currentSessionId });
        }
      },
    });

    return Promise.resolve(stream);
  }

  /**
   * 重连到已有流（不支持）
   *
   * 主进程未持久化流状态，刷新页面后无法恢复之前的对话流。
   * 返回 null 表示不支持重连，useChat 会把 status 设为 'ready'。
   *
   * 若未来需要支持（如主进程持久化 sessionId + 末次 chunk index），
   * 可在此调用 window.api.chat.reconnect({ sessionId }) 重连。
   */
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

/**
 * 从 UIMessage 中提取纯文本内容
 *
 * 拼接 parts 数组中所有 TextUIPart 的 text 字段，
 * 忽略 tool/reasoning/file 等非文本 part。
 *
 * 使用 AI SDK 官方 isTextUIPart 类型守卫过滤，类型安全且无 any。
 *
 * 多个 text part 之间用换行分隔（保留多个文本块的语义边界）。
 */
function extractTextContent(message: UIMessage): string {
  // parts 中可能混合 text/tool/reasoning 等多种 part，仅提取 text
  // isTextUIPart 是 AI SDK v7 内置类型守卫，运行时按 type 字段判断
  const textParts = message.parts.filter(isTextUIPart);
  return textParts.map((part) => part.text).join('\n');
}
