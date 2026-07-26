// src/main/infra/ai/tools/terminal.tool.ts
// terminal 工具：创建和管理交互式终端会话
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { ITerminalService } from '../../terminal/terminal-service';
import type { Tool, ToolContext, ToolResult } from '../tool';
import { resolveWithinWorkspace } from './path-guard';

const TerminalActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    command: z
      .string()
      .optional()
      .describe('启动命令（省略时打开默认 shell）')
      .transform((v) => v ?? undefined),
    cwd: z
      .string()
      .optional()
      .describe('工作目录（相对路径基于 agent 工作目录解析，省略时用工作目录）')
      .transform((v) => v ?? undefined),
    cols: z.number().int().positive().max(500).default(80).describe('终端列数，默认 80'),
    rows: z.number().int().positive().max(200).default(24).describe('终端行数，默认 24'),
  }),
  z.object({
    action: z.literal('input'),
    terminalId: z.string().min(1).describe('终端会话 id'),
    data: z.string().describe('要写入终端的数据（命令、按键等）'),
  }),
  z.object({
    action: z.literal('read'),
    terminalId: z.string().min(1).describe('终端会话 id'),
  }),
  z.object({
    action: z.literal('clear'),
    terminalId: z.string().min(1).describe('终端会话 id'),
  }),
  z.object({
    action: z.literal('resize'),
    terminalId: z.string().min(1).describe('终端会话 id'),
    cols: z.number().int().positive().max(500).describe('新的列数'),
    rows: z.number().int().positive().max(200).describe('新的行数'),
  }),
  z.object({
    action: z.literal('kill'),
    terminalId: z.string().min(1).describe('终端会话 id'),
  }),
]);

type TerminalInput = z.infer<typeof TerminalActionSchema>;

export function createTerminalTool(terminalService: ITerminalService): Tool<TerminalInput> {
  return {
    name: 'terminal',
    description:
      '创建和管理交互式终端会话。支持创建终端、输入命令、读取输出、调整尺寸、终止终端等操作。终端输出会实时推送到前端面板。注意：终端可以执行任意系统命令，属于高风险操作，需用户审批后执行。',
    inputSchema: TerminalActionSchema,
    permission: 'ask',
    execute: async (input: TerminalInput, ctx: ToolContext): Promise<ToolResult> => {
      switch (input.action) {
        case 'create': {
          const cwd =
            input.cwd !== undefined
              ? resolveWithinWorkspace(input.cwd, ctx.workingDir)
              : ctx.workingDir;
          const result = await terminalService.create({
            cwd,
            command: input.command,
            env: undefined,
            cols: input.cols,
            rows: input.rows,
            webContents: ctx.webContents,
          });
          const title = input.command ?? 'shell';
          return {
            title: `创建终端: ${title}`,
            output: `终端已创建，terminalId: ${result.terminalId}\n工作目录: ${cwd}\nPID: ${result.pid}`,
            metadata: {
              terminalId: result.terminalId,
              sessionId: ctx.sessionId,
              title,
              pid: result.pid,
              cwd,
              command: input.command,
              cols: input.cols,
              rows: input.rows,
              action: 'create',
            },
          };
        }
        case 'input': {
          const result = await terminalService.input(input.terminalId, input.data);
          if (!result.ok) {
            return {
              title: `输入终端: ${input.terminalId}`,
              output: `[错误] 终端不存在或已关闭: ${input.terminalId}`,
              metadata: { terminalId: input.terminalId, ok: false },
            };
          }
          return {
            title: `输入终端: ${input.terminalId}`,
            output: `已写入 ${input.data.length} 字节到终端`,
            metadata: { terminalId: input.terminalId, ok: true, bytesWritten: input.data.length },
          };
        }
        case 'read': {
          const output = terminalService.getOutput(input.terminalId);
          return {
            title: `读取终端: ${input.terminalId}`,
            output: output || '(无输出)',
            metadata: { terminalId: input.terminalId, outputLength: output.length },
          };
        }
        case 'clear': {
          terminalService.clearOutput(input.terminalId);
          return {
            title: `清空终端: ${input.terminalId}`,
            output: '终端输出缓冲已清空',
            metadata: { terminalId: input.terminalId },
          };
        }
        case 'resize': {
          const result = await terminalService.resize(input.terminalId, input.cols, input.rows);
          if (!result.ok) {
            return {
              title: `调整终端: ${input.terminalId}`,
              output: `[错误] 终端不存在或已关闭: ${input.terminalId}`,
              metadata: { terminalId: input.terminalId, ok: false },
            };
          }
          return {
            title: `调整终端: ${input.terminalId}`,
            output: `终端尺寸已调整为 ${input.cols}x${input.rows}`,
            metadata: {
              terminalId: input.terminalId,
              ok: true,
              cols: input.cols,
              rows: input.rows,
            },
          };
        }
        case 'kill': {
          const result = await terminalService.kill(input.terminalId);
          if (!result.ok) {
            return {
              title: `终止终端: ${input.terminalId}`,
              output: `[错误] 终端不存在: ${input.terminalId}`,
              metadata: { terminalId: input.terminalId, ok: false },
            };
          }
          return {
            title: `终止终端: ${input.terminalId}`,
            output: '终端已终止',
            metadata: { terminalId: input.terminalId, ok: true },
          };
        }
      }
    },
  };
}
