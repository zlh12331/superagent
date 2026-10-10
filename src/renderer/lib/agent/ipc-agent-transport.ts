import type { AgentRunRes, ChatMessage, ThinkingLevel } from '@code-agent/shared/renderer';
import {
  type ChatRequestOptions,
  type ChatTransport,
  convertToModelMessages,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { unwrap } from '@/lib/ipc';
import { createStreamChunkBatcher } from './stream-chunk-batcher';

/**
 * 按会话配置的缓存上限
 *
 * transport 为模块级单例，configureFor 以会话 id 为键——无上限则随「打开过的
 * 会话数」永久累积。取 20：远超单窗口并发回合数（同屏 ChatPanel 至多 1 个活跃），
 * 又不至成为内存负担。
 */
const CONFIG_CACHE_LIMIT = 20;

/**
 * Agent 配置（通过 configure 注入到 transport 实例）
 *
 * 可选字段的 undefined 是有意义的值（"本轮显式无覆盖"）而非键缺席：
 * configure/configureFor 语义是「合并」——显式 undefined 键覆盖 prev 旧值，
 * 键缺席则 sticky（2026-09-28 修复：此前调用方为绕 exactOptionalPropertyTypes
 * 把 undefined 键 omit 掉，导致「清空 systemPrompt」永远无法覆盖缓存旧值）。
 * 装配请用 buildAgentTransportConfig（保证全键存在）。
 */
export interface AgentConfig {
  /** 工作目录（必填）：限制所有文件操作的根目录 */
  readonly workingDir: string;
  /** 可选系统提示词（覆盖主进程默认 system prompt）；undefined = 无自定义 */
  readonly systemPrompt?: string | undefined;
  /** 最大工具调用轮数（默认 20，上限 50） */
  readonly maxSteps?: number | undefined;
  /** 运行模式（plan 只读探索 / build 审批后执行，缺省 build） */
  readonly mode?: 'plan' | 'build' | undefined;
  /** 思考强度（可选：渲染层设置项，覆盖主进程模型级默认） */
  readonly thinking?: ThinkingLevel | undefined;
  /** 采样温度（可选：渲染层设置项，覆盖模型级默认；DeepSeek 思考模型忽略） */
  readonly temperature?: number | undefined;
  /** 目标模型 id（设置项 ai.defaultModel：模型选择器的当前选择，主进程据此路由） */
  readonly modelId?: string | undefined;
}

/**
 * 从 hook 侧输入装配 AgentConfig——全键传入（undefined 键显式存在）
 *
 * 独立成纯函数的原因：装配此前内联在 use-agent 的条件展开里，undefined 键被
 * omit 导致「清空 systemPrompt」永远无法覆盖 transport 缓存的旧值（静默语义
 * 漂移，无任何报错）。抽出后"全键存在"这一不变量可直接被断言。
 *
 * @param input hook 侧解析后的有效值（undefined = 本轮无覆盖/已清空）
 * @returns AgentConfig（显式 undefined 覆盖语义，见 AgentConfig 注释）
 */
export function buildAgentTransportConfig(input: {
  workingDir: string;
  systemPrompt: string | undefined;
  maxSteps: number | undefined;
  thinking: ThinkingLevel | undefined;
  temperature: number | undefined;
  modelId: string | undefined;
}): AgentConfig {
  return {
    workingDir: input.workingDir,
    systemPrompt: input.systemPrompt,
    maxSteps: input.maxSteps,
    thinking: input.thinking,
    temperature: input.temperature,
    modelId: input.modelId,
  };
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
   *
   * 上限 CONFIG_CACHE_LIMIT：transport 是模块级单例（见 getIpcAgentTransport），
   * 而 configureFor 以会话 id 为键——不加限制则「打开过的会话数」会永久累积
   * （每个条目仅 workingDir 等小字段，但属无界增长）。超限时按插入序淘汰最旧
   * （Map 迭代序即插入序），当前活跃会话因刚写入总在末尾而不会被淘汰。
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
    if (prev !== undefined) {
      this.configs.delete(chatId);
    }
    this.configs.set(chatId, {
      ...prev,
      ...config,
      workingDir: config.workingDir ?? prev?.workingDir,
    });
    if (this.configs.size > CONFIG_CACHE_LIMIT) {
      const oldest = this.configs.keys().next();
      if (!oldest.done) {
        this.configs.delete(oldest.value);
      }
    }
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
    const config = this.configs.get(options.chatId) ?? this.lastConfig;
    if (config === undefined) {
      return Promise.reject(
        new Error(
          'IpcAgentTransport: workingDir not configured. Call configure()/configureFor() first.',
        ),
      );
    }
    const { workingDir, systemPrompt, maxSteps, mode, thinking, temperature, modelId } = config;

    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const batcher = createStreamChunkBatcher({
          emit: (chunk) => controller.enqueue(chunk),
        });

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

        if (options.abortSignal !== undefined) {
          options.abortSignal.addEventListener(
            'abort',
            () => {
              void window.api.agent.stop({ sessionId: options.chatId });
            },
            { once: true },
          );
        }

        let data: AgentRunRes;
        try {
          const chatMessages: ChatMessage[] = await convertToModelMessages(options.messages);
          data = unwrap(
            await window.api.agent.run({
              messages: chatMessages,
              sessionId: options.chatId,
              workingDir,
              systemPrompt,
              maxSteps: maxSteps ?? 20,
              mode: mode ?? 'build',
              thinking,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(modelId !== undefined ? { modelId } : {}),
            }),
          );
        } catch (err) {
          cleanup?.();
          controller.error(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (data.sessionId !== options.chatId) {
          cleanup?.();
          controller.error(
            new Error(
              `[IPC_CONTRACT] agent.run sessionId 回显不一致：${data.sessionId}（期望 ${options.chatId}）`,
            ),
          );
        }
      },
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
