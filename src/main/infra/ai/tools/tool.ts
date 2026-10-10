// tool.ts：工具契约——每个工具 = 名字/描述/输入 schema/权限档/类别 + execute
import type { Schema } from 'ai';
import type { WebContents } from 'electron';
import type { ZodType } from 'zod';

/** 工具执行上下文（turn-assembly 组装；metadata 用于回合内追加结构化数据） */
export interface ToolContext {
  readonly workingDir: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
  readonly abortSignal: AbortSignal;
  readonly webContents?: WebContents;
  readonly metadata?: (data: Record<string, unknown>) => void;
  readonly mode?: 'plan' | 'build';
  readonly userPrompt?: string;
  readonly contextWindowSize?: number | undefined;
}

/** 工具执行结果：title（UI 展示）+ output（模型可见文本）+ metadata（可选结构化） */
export interface ToolResult {
  readonly title: string;
  readonly output: string;
  readonly metadata?: Record<string, unknown>;
}

/** 工具类别：read=只读 / control=系统控制 / edit=写文件 / exec=执行命令（审批 UI 分组依据） */
export type ToolCategory = 'read' | 'control' | 'edit' | 'exec';

/** 工具契约：permission='ask' 的工具执行前必经审批（permission-service 决策） */
export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput> | Schema<TInput>;
  readonly permission: 'auto' | 'ask';
  readonly category: ToolCategory;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
