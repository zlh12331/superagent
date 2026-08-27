// src/renderer/hooks/use-agent.ts
// useAgentWithIpc：Code Agent 专用 hook，注入 IpcAgentTransport 并透传 agent 配置
//
// 职责：
// 1. 创建并复用 IpcAgentTransport 单例（无状态，共享安全）
// 2. 在 workingDir / systemPrompt / maxSteps 变化时调用 transport.configure()
// 3. 包装 useChat，注入 transport + 透传 useChat 的其余 options
//
// 使用示例：
// ```tsx
// import { useAgentWithIpc } from '@/hooks/use-agent';
//
// function AgentPanel({ workingDir }: { workingDir: string }) {
//   const { messages, sendMessage, status, stop } = useAgentWithIpc({
//     id: 'agent-session',
//     workingDir,
//     systemPrompt: 'You are a helpful coding assistant.',
//     maxSteps: 30,
//   });
//   // 渲染 messages / 输入框 / 发送按钮 / stop 按钮...
// }
// ```
//
// 与 useChatWithIpc 的区别：
// - useChatWithIpc：单轮流式对话（无工具调用），走 chat:send IPC
// - useAgentWithIpc：多轮工具调用，走 agent:run IPC，支持文件操作 / 命令执行等

import { type UseChatOptions, useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useEffect, useMemo } from 'react';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { IpcAgentTransport } from '../lib/agent/ipc-agent-transport';

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
  const transport = useMemo(() => getIpcAgentTransport(), []);

  // 用户设置项（settings-store persistent；变化时重新 configure）：
  // 思考强度 / 采样温度直接透传；系统提示词为空串时回落主进程内置默认 prompt
  const thinking = useSettingsStore((s) => s.ai.thinking);
  const temperature = useSettingsStore((s) => s.ai.temperature);
  const settingsSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);

  // 解构 agent 专用字段（id 用于按会话配置 transport），剩余透传给 useChat
  const { id, workingDir, systemPrompt, maxSteps, ...chatOptions } = options;

  // 有效系统提示词：显式 options.systemPrompt > 设置项（非空）> 主进程默认
  const effectiveSystemPrompt =
    systemPrompt ?? (settingsSystemPrompt.trim().length > 0 ? settingsSystemPrompt : undefined);

  // 在 agent 配置变化时同步更新 transport（useEffect 确保在 render 后执行）
  // sendMessage 由用户交互触发（总是在 effect 执行后），不存在竞态
  // 使用条件展开避免 exactOptionalPropertyTypes 下 string | undefined 报错
  // 按会话 id 配置（并发回合支持）：各 ChatPanel 的 useChat id = chatId，互不覆盖
  useEffect(() => {
    transport.configureFor(id ?? 'agent-chat', {
      workingDir,
      ...(effectiveSystemPrompt !== undefined ? { systemPrompt: effectiveSystemPrompt } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    });
  }, [transport, id, workingDir, effectiveSystemPrompt, maxSteps, thinking, temperature]);

  return useChat<Message>({
    ...chatOptions,
    transport,
  });
}
