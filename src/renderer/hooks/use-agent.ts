import { type UseChatOptions, useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { buildAgentTransportConfig, IpcAgentTransport } from '../lib/agent/ipc-agent-transport';

/**
 * IpcAgentTransport 单例
 *
 * 模块级单例，整个应用生命周期共享一个实例。
 * ChatTransport 是无状态的（每次 sendMessages 都创建新的 ReadableStream），
 * agent 配置（workingDir 等）通过 configure() 方法注入，不在 transport 实例上长期存储。
 */
let ipcAgentTransport: IpcAgentTransport | null = null;

/**
 * 获取 IpcAgentTransport 单例
 */
export function getIpcAgentTransport(): IpcAgentTransport {
  if (ipcAgentTransport === null) {
    ipcAgentTransport = new IpcAgentTransport();
  }
  return ipcAgentTransport;
}

/**
 * useAgentWithIpc 选项
 *
 * 扩展 UseChatOptions，新增 agent 专用配置字段。
 * workingDir 为必填（Code Agent 的核心约束），systemPrompt / maxSteps 可选。
 *
 * 注：UseChatOptions 是联合类型（{ chat: Chat } | ChatInit），不能用 interface extends，
 * 只能用交叉类型。
 */
type UseAgentOptions<Message extends UIMessage> = UseChatOptions<Message> & {
  /** useChat 会话 id（透传：AI SDK 内部聊天标识，transport 按此配置会话专属参数） */
  readonly id?: string;
  /** 工作目录（必填）：限制所有文件操作的根目录 */
  readonly workingDir: string;
  /** 可选系统提示词（覆盖主进程默认 system prompt） */
  readonly systemPrompt?: string;
  /** 最大工具调用轮数（默认 20，上限 50） */
  readonly maxSteps?: number;
};

/**
 * Code Agent hook：基于 IPC AgentTransport 的多轮工具调用对话能力
 *
 * @typeParam Message 渲染层 UIMessage 类型，默认为 UIMessage 基类
 * @param options 含 workingDir（必填）+ 透传给 useChat 的 options
 * @returns useChat 返回值（messages / sendMessage / status / error / stop / regenerate 等）
 *
 * @example
 * ```tsx
 * const { messages, sendMessage, status } = useAgentWithIpc({
 *   id: 'agent',
 *   workingDir: '/path/to/project',
 * });
 *
 * await sendMessage({ text: '帮我创建一个 hello.ts 文件' });
 * // agent 会调用 write_file 工具（需用户审批），然后返回结果
 * ```
 */
export function useAgentWithIpc<Message extends UIMessage = UIMessage>(
  options: UseAgentOptions<Message>,
) {
  const transport = getIpcAgentTransport();

  const thinking = useSettingsStore((s) => s.ai.thinking);
  const temperature = useSettingsStore((s) => s.ai.temperature);
  const settingsSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);
  const modelId = useSettingsStore((s) => s.ai.defaultModel);

  const { id, workingDir, systemPrompt, maxSteps, ...chatOptions } = options;

  const effectiveSystemPrompt =
    systemPrompt ?? (settingsSystemPrompt.trim().length > 0 ? settingsSystemPrompt : undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transport 为模块级单例（引用恒定），不入依赖
  useEffect(() => {
    transport.configureFor(
      id ?? 'agent-chat',
      buildAgentTransportConfig({
        workingDir,
        systemPrompt: effectiveSystemPrompt,
        maxSteps,
        thinking,
        temperature,
        modelId,
      }),
    );
  }, [id, workingDir, effectiveSystemPrompt, maxSteps, thinking, temperature, modelId]);

  return useChat<Message>({
    ...chatOptions,
    ...(id !== undefined ? { id } : {}),
    transport,
  });
}
