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

import type { ChatMessage, ThinkingLevel } from '@code-agent/shared/renderer';
import {
  type ChatRequestOptions,
  type ChatTransport,
  convertToModelMessages,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { createStreamChunkBatcher } from './stream-chunk-batcher';

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
  /** 运行模式（plan 只读探索 / build 审批后执行，缺省 build） */
  readonly mode?: 'plan' | 'build';
  /** 思考强度（可选：渲染层设置项，覆盖主进程模型级默认） */
  readonly thinking?: ThinkingLevel;
  /** 采样温度（可选：渲染层设置项，覆盖模型级默认；DeepSeek 思考模型忽略） */
  readonly temperature?: number;
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
  /**
   * 各会话的 agent 配置（chatId → config）
   *
   * configureFor(chatId, config) 按 useChat id 记录；sendMessages 优先按
   * options.chatId 精确匹配（调用方透传 id 时 chatId === 会话 id），
   * 未命中则回落 lastConfig（调用方未传 id 时 useChat 自生成随机 chatId，
   * 兜底保证单会话架构稳定）。
   */
  private readonly configs = new Map<string, AgentConfig>();
  /** 最近一次配置（任意 configure/configureFor 均更新；sendMessages 兜底） */
  private lastConfig: AgentConfig | undefined;

  /**
   * 更新 agent 配置（无会话 id：写入兜底配置，供未显式按会话配置的调用）
   *
   * 多 ChatPanel 场景请用 configureFor(chatId, config) 按会话隔离。
   * 配置在下次 sendMessages 调用时生效。
   */
  configure(config: AgentConfig): void {
    this.lastConfig = {
      ...this.lastConfig,
      ...config,
      workingDir: config.workingDir ?? this.lastConfig?.workingDir,
    };
  }

  /**
   * 按会话配置 agent 配置
   *
   * @param chatId useChat id（= 会话 id），sendMessages 时优先按此查专属配置
   */
  configureFor(chatId: string, config: AgentConfig): void {
    const prev = this.configs.get(chatId);
    this.configs.set(chatId, {
      ...prev,
      ...config,
      workingDir: config.workingDir ?? prev?.workingDir,
    });
    // 同步兜底配置：调用方未传 id 时 useChat 自生成随机 chatId，sendMessages
    // 无法命中 Map 时回落最近配置（单会话架构等价于原单例行为）
    this.lastConfig = {
      ...this.lastConfig,
      ...config,
      workingDir: config.workingDir ?? this.lastConfig?.workingDir,
    };
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
    if (this.configs.size === 0 && this.lastConfig === undefined) {
      return Promise.reject(
        new Error(
          'IpcAgentTransport: workingDir not configured. Call configure()/configureFor() first.',
        ),
      );
    }
    // 优先按会话查专属配置（调用方透传 id 时 chatId = 会话 id）；
    // 未命中回落最近配置（调用方未传 id 的稳定路径）
    const config = this.configs.get(options.chatId) ?? this.lastConfig;
    if (config === undefined) {
      return Promise.reject(
        new Error(
          'IpcAgentTransport: workingDir not configured. Call configure()/configureFor() first.',
        ),
      );
    }
    const { workingDir, systemPrompt, maxSteps, mode, thinking, temperature } = config;

    // P1 修复：直接用同步已知的 chatId 过滤事件流。此前等 agent.run 响应返回才填
    // currentSessionId，而主进程 push 事件可能先于 invoke 响应到达（startAgent 为
    // fire-and-forget 启动后立即 return），导致首段 token / 首个工具事件被静默丢弃、
    // abort 窗口内 stop 因 id 未定而失效。主进程以入参 sessionId（= chatId）回显与
    // 推送，二者恒等，无需等待响应。
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<UIMessageChunk>({
      async start(controller) {
        // 出口批处理器：合并相邻 text-delta ⇒ 每 token 一次 DOM 提交降为每窗口一次
        // （长回复的 react-markdown 全量重解析从 O(n²) 降为 O(n·窗口提交数)）
        const batcher = createStreamChunkBatcher({
          emit: (chunk) => controller.enqueue(chunk),
        });

        // 订阅 agent:stream:* 三个 IPC 事件（按 chatId 过滤）
        const offPart = window.api.agent.subscribeStreamPart(({ sessionId, part }) => {
          if (sessionId !== options.chatId) {
            return;
          }
          batcher.push(part as UIMessageChunk);
        });

        const offEnd = window.api.agent.subscribeStreamEnd(({ sessionId }) => {
          if (sessionId !== options.chatId) {
            return;
          }
          // 先落地缓冲文本再关闭：否则末段 token 会随定时器一起被丢弃
          batcher.flush();
          cleanup?.();
          controller.close();
        });

        const offError = window.api.agent.subscribeStreamError(({ sessionId, code, message }) => {
          if (sessionId !== options.chatId) {
            return;
          }
          batcher.flush();
          cleanup?.();
          controller.error(new Error(`[${code}] ${message}`));
        });

        cleanup = () => {
          offPart();
          offEnd();
          offError();
          batcher.dispose();
        };

        // abortSignal 处理：用户点击 stop 按钮时触发
        // （chatId 同步可用，in-flight 的 run invoke 期间中断同样生效）
        if (options.abortSignal !== undefined) {
          options.abortSignal.addEventListener(
            'abort',
            () => {
              void window.api.agent.stop({ sessionId: options.chatId });
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
          // plan 模式：写操作被主进程直接拒绝（只读探索）；缺省 build
          mode: mode ?? 'build',
          // 思考强度：设置项覆盖主进程模型级默认（undefined = 用模型默认）
          thinking,
          // 采样温度：设置项覆盖模型级默认（undefined = 用模型默认）
          ...(temperature !== undefined ? { temperature } : {}),
        });

        // 处理响应：失败则 error stream；成功则校验 sessionId 回显（契约显式化）
        if ('error' in response && response.error !== undefined) {
          cleanup?.();
          controller.error(new Error(`[${response.error.code}] ${response.error.message}`));
          return;
        }
        // 跨进程契约守卫：AgentRunRes.sessionId 必须与发起时的 chatId 一致
        // （主进程以入参 sessionId 回显；后续所有流式事件按 chatId 过滤）。
        // 不一致 = 契约被破坏（事件永远无法匹配，流悬挂到超时），fail-loud 而非静默。
        if (
          'data' in response &&
          response.data !== undefined &&
          response.data.sessionId !== options.chatId
        ) {
          cleanup?.();
          controller.error(
            new Error(
              `[IPC_CONTRACT] agent.run sessionId 回显不一致：${response.data.sessionId}（期望 ${options.chatId}）`,
            ),
          );
        }
      },
      // cancel：流被 useChat 主动取消（如组件卸载）时触发
      cancel() {
        cleanup?.();
        void window.api.agent.stop({ sessionId: options.chatId });
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
