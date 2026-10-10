import type { Schema } from 'ai';
import type { WebContents } from 'electron';
import type { ZodType } from 'zod';

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

export interface ToolResult {
  readonly title: string;
  readonly output: string;
  readonly metadata?: Record<string, unknown>;
}

export type ToolCategory = 'read' | 'control' | 'edit' | 'exec';

export interface Tool<TInput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput> | Schema<TInput>;
  readonly permission: 'auto' | 'ask';
  readonly category: ToolCategory;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
