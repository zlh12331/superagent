// src/renderer/lib/agent/ipc-agent-transport.ts
// 自定义 ChatTransport：把 useChat 与 Electron IPC（agent 域）桥接
//
// 设计目标：
// 在 contextIsolation: true + sandbox: true 环境下，让 Vercel AI SDK 的 useChat
// 通过 window.api.agent IPC 与主进程 AgentService 通信，实现多轮工具调用的 Code Agent。
//
// 与 IpcChatTransport 的区别：
// - chat.send：单轮流式响应（streamText 不带 tools）
// - agent.run：多轮工具调用（streamText 带 tools + stopWhen，自动循环）
// - agent.run 额外需要 workingDir（必填）/ systemPrompt? / maxSteps? 参数
// - 这些参数通过 configure() 方法注入到 transport 实例（而非 useChat body）
//
// 工作流程：
// 1. useAgentWithIpc hook 调用 transport.configure({ workingDir, ... }) 设置 agent 配置
// 2. useChat 调用 transport.sendMessages({ messages, abortSignal, ... })
// 3. transport 用官方 convertToModelMessages 把 UIMessage[] 转换为 ChatMessage[]
// 4. transport 创建 ReadableStream<UIMessageChunk> 并：
//    a. 订阅 window.api.agent 的 streamPart/End/Error 三个 IPC 事件
//    b. 调用 window.api.agent.run() 触发主进程 startAgent
//    c. 收到 part 事件时 enqueue 到 stream
//    d. 收到 end 事件时 close stream
//    e. 收到 error 事件时 error stream
//    f. abortSignal 触发时调用 window.api.agent.stop() 中断主进程
// 5. useChat 自动消费 ReadableStream，更新 messages 状态
//
// 安全说明：
// - 渲染层不直接调用 AI SDK，API key 留主进程
// - workingDir 由渲染层传入，主进程 path-guard 二次校验
// - sessionId 用于过滤当前对话的事件

import type { ChatMessage } from '@novel-writer/shared';
import {
  type ChatRequestOptions,
  type ChatTransport,
  convertToModelMessages,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

/**
 * Agent 配置（通过 configure 注入到 transport 实例）
 */
interface AgentConfig {
  /** 工作目录（必填）：限制所有文件操作的根目录 */
  readonly workingDir: string;
  /** 可选系统提示词（覆盖主进程默认 system prompt） */
  readonly systemPrompt?: string;
  /** 最大工具调用轮数（默认 20，上限 50） */
  readonly maxSteps?: number;
}

/**
 * IpcAgentTransport：Electron IPC 适配的 ChatTransport 实现（Agent 域）
 *
 * 实现官方 ChatTransport 接口，桥接 useChat 与 window.api.agent IPC API。
 * 与 IpcChatTransport 共享相同的流式桥接模式，但调用 agent.run/stop 而非 chat.send/stop。
 *
 * 配置注入：
 * - workingDir / systemPrompt / maxSteps 通过 configure() 方法注入
 * - useAgentWithIpc hook 在 workingDir 变化时自动调用 configure()
 * - transport 实例为模块级单例（ChatTransport 无状态，共享安全）
 *
 * @typeParam Message 渲染层 UIMessage 类型，默认为 UIMessage 基类
 *
 * @example
 * ```tsx
 * import { useAgentWithIpc } from '@/hooks/use-agent';
 *
 * const { messages, sendMessage } = useAgentWithIpc({
 *   id: 'agent-chat',
 *   workingDir: '/path/to/project',
 * });
 * ```
 */
export class IpcAgentTransport<Message extends UIMessage = UIMessage>
  implements ChatTransport<Message>
{
  /** Agent 配置（由 hook 通过 configure 注入） */
  private config: AgentConfig | undefined;

  /**
   * 更新 agent 配置
   *
   * 由 useAgentWithIpc hook 在 workingDir / systemPrompt / maxSteps 变化时调用。
   * 配置在下次 sendMessages 调用时生效。
   *
   * @param config 含 workingDir（必填）+ 可选 systemPrompt / maxSteps
   */
  configure(config: AgentConfig): void {
    this.config = config;
  }

  /**
   * 发送消息并返回流式响应
   *
   * 被 useChat 内部调用，传入当前消息历史 + abortSignal，
   * 返回一个 UIMessageChunk 流，useChat 自动消费并更新 messages 状态。
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
    if (this.config === undefined) {
      return Promise.reject(
        new Error('IpcAgentTransport: workingDir not configured. Call configure() first.'),
      );
    }
    const { workingDir, systemPrompt, maxSteps } = this.config;

    // currentSessionId 在 agent.run 返回后填充，初始为 undefined
    let currentSessionId: string | undefined;
    // 统一清理函数
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<UIMessageChunk>({
      async start(controller) {
        // 订阅 agent:stream:* 三个 IPC 事件（按 sessionId 过滤）
        const offPart = window.api.agent.subscribeStreamPart(({ sessionId, part }) => {
          if (sessionId !== currentSessionId) {
            return;
          }
          controller.enqueue(part as UIMessageChunk);
        });

        const offEnd = window.api.agent.subscribeStreamEnd(({ sessionId }) => {
          if (sessionId !== currentSessionId) {
            return;
          }
          cleanup?.();
          controller.close();
        });

        const offError = window.api.agent.subscribeStreamError(({ sessionId, code, message }) => {
          if (sessionId !== currentSessionId) {
            return;
          }
          cleanup?.();
          controller.error(new Error(`[${code}] ${message}`));
        });

        cleanup = () => {
          offPart();
          offEnd();
          offError();
        };

        // abortSignal 处理：用户点击 stop 按钮时触发
        if (options.abortSignal !== undefined) {
          options.abortSignal.addEventListener(
            'abort',
            () => {
              if (currentSessionId !== undefined) {
                void window.api.agent.stop({ sessionId: currentSessionId });
              }
            },
            { once: true },
          );
        }

        // 转换消息：UIMessage[] → ChatMessage[]（= ModelMessage[]）
        const chatMessages: ChatMessage[] = await convertToModelMessages(options.messages);

        // 触发主进程 agent:run（异步推送 part）
        const response = await window.api.agent.run({
          messages: chatMessages,
          // 传入 chatId 作为 sessionId：让主进程关联到持久化的会话
          // （messages 落库 + workingDir 校验 + 事件按 sessionId 过滤）
          sessionId: options.chatId,
          workingDir,
          systemPrompt,
          maxSteps: maxSteps ?? 20,
        });

        // 处理响应：失败则 error stream，成功则记录 sessionId
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
      cancel() {
        cleanup?.();
        if (currentSessionId !== undefined) {
          void window.api.agent.stop({ sessionId: currentSessionId });
        }
      },
    });

    return Promise.resolve(stream);
  }

  /**
   * 重连到已有流（不支持）
   *
   * 主进程未持久化流状态，刷新页面后无法恢复之前的 agent 对话流。
   */
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}
