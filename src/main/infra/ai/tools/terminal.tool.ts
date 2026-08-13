// src/main/infra/ai/tools/terminal.tool.ts
// terminal 工具：创建和管理交互式终端会话
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { ITerminalService } from '../../terminal/terminal-service';
import { resolveWithinWorkspace } from './path-guard';
import type { Tool, ToolContext, ToolResult } from './tool';

// 扁平 object（而非 discriminatedUnion）：DeepSeek 等 OpenAI 兼容 API 对
// 判别联合 + transform 的 JSON Schema 序列化产出 `type: null`，整请求 400
//（实测错误：Invalid schema for function 'terminal': ... got 'type: null'）。
// 各 action 的必填约束由 execute 内运行时守卫兜底（对 LLM 生成宽松、对执行严格）。
const TerminalActionSchema = z.object({
  action: z.enum(['create', 'input', 'read', 'clear', 'resize', 'kill']).describe('操作类型'),
  command: z.string().optional().describe('启动命令（省略时打开默认 shell；仅 create 使用）'),
  cwd: z
    .string()
    .optional()
    .describe('工作目录（相对路径基于 agent 工作目录解析，省略时用工作目录；仅 create 使用）'),
  terminalId: z.string().optional().describe('终端会话 id（input/read/clear/resize/kill 必填）'),
  data: z.string().optional().describe('要写入终端的数据（命令、按键等；仅 input 必填）'),
  cols: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('终端列数（create 默认 80；resize 必填）'),
  rows: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('终端行数（create 默认 24；resize 必填）'),
});

type TerminalInput = z.infer<typeof TerminalActionSchema>;

export function createTerminalTool(terminalService: ITerminalService): Tool<TerminalInput> {
  return {
    name: 'terminal',
    description:
      '创建和管理交互式终端会话。支持创建终端、输入命令、读取输出、调整尺寸、终止终端等操作。终端输出会实时推送到前端面板。注意：终端可以执行任意系统命令，属于高风险操作，需用户审批后执行。',
    inputSchema: TerminalActionSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: TerminalInput, ctx: ToolContext): Promise<ToolResult> => {
      // 无头场景（IM 桥接等）拒绝：终端输出推送依赖桌面窗口
      if (ctx.webContents === undefined) {
        return { title: '终端不可用', output: '终端工具需要桌面窗口，无头执行不支持。' };
      }
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
            cols: input.cols ?? 80,
            rows: input.rows ?? 24,
            // 守卫后已收窄为非空，直接传递
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
          if (input.terminalId === undefined || input.data === undefined) {
            return { title: '参数缺失', output: 'input 操作需要 terminalId 与 data 参数' };
          }
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
          if (input.terminalId === undefined) {
            return { title: '参数缺失', output: 'read 操作需要 terminalId 参数' };
          }
          const output = terminalService.getOutput(input.terminalId);
          return {
            title: `读取终端: ${input.terminalId}`,
            output: output || '(无输出)',
            metadata: { terminalId: input.terminalId, outputLength: output.length },
          };
        }
        case 'clear': {
          if (input.terminalId === undefined) {
            return { title: '参数缺失', output: 'clear 操作需要 terminalId 参数' };
          }
          terminalService.clearOutput(input.terminalId);
          return {
            title: `清空终端: ${input.terminalId}`,
            output: '终端输出缓冲已清空',
            metadata: { terminalId: input.terminalId },
          };
        }
        case 'resize': {
          if (
            input.terminalId === undefined ||
            input.cols === undefined ||
            input.rows === undefined
          ) {
            return { title: '参数缺失', output: 'resize 操作需要 terminalId、cols 与 rows 参数' };
          }
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
          if (input.terminalId === undefined) {
            return { title: '参数缺失', output: 'kill 操作需要 terminalId 参数' };
          }
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
