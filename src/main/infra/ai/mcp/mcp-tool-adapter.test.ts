// src/main/infra/ai/mcp/mcp-tool-adapter.test.ts
// mcp-tool-adapter 单测：MCP 工具适配器
//
// 测试要点：
// 1. decideMcpToolPermission：权限决策（permissionOverride > readOnlyHint > 默认 'ask'）
// 2. normalizeMcpToolResult：结果标准化（isError 抛错 / structuredContent 优先 / text 拼接）
// 3. adaptMcpTool：适配 Tool 实例（命名空间、权限、execute 转发）

import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../tools/tool';
import {
  adaptMcpTool,
  decideMcpToolPermission,
  type McpCallToolFn,
  type McpToolCallResult,
  type McpToolDescriptor,
  normalizeMcpToolResult,
} from './mcp-tool-adapter';
import type { McpServerConfig } from './mcp-types';

// Mock WebContents：测试不依赖事件推送，仅满足 ToolContext 类型契约
const mockWebContents = {
  send: vi.fn(),
  isDestroyed: vi.fn(() => false),
} as unknown as WebContents;

// 构造默认 ToolContext
function makeCtx(): ToolContext {
  return {
    workingDir: '/workspace',
    sessionId: 'test-session',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: mockWebContents,
  };
}

describe('mcp-tool-adapter', () => {
  describe('decideMcpToolPermission', () => {
    const baseConfig: McpServerConfig = {
      name: 'fs',
      command: 'npx',
    };

    it('permissionOverride 优先级最高（auto）', () => {
      const config: McpServerConfig = {
        ...baseConfig,
        permissionOverride: 'auto',
      };
      expect(decideMcpToolPermission(config, { destructiveHint: true })).toBe('auto');
    });

    it('permissionOverride 优先级最高（ask）', () => {
      const config: McpServerConfig = {
        ...baseConfig,
        permissionOverride: 'ask',
      };
      expect(decideMcpToolPermission(config, { readOnlyHint: true })).toBe('ask');
    });

    it('无 override 时 readOnlyHint=true → auto', () => {
      expect(decideMcpToolPermission(baseConfig, { readOnlyHint: true })).toBe('auto');
    });

    it('无 override 且 readOnlyHint=false → ask（安全默认）', () => {
      expect(decideMcpToolPermission(baseConfig, { readOnlyHint: false })).toBe('ask');
    });

    it('annotations 为 undefined → ask（安全默认）', () => {
      expect(decideMcpToolPermission(baseConfig, undefined)).toBe('ask');
    });

    it('annotations 其他 hint 不影响决策（仅 readOnlyHint 生效）', () => {
      expect(
        decideMcpToolPermission(baseConfig, {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        }),
      ).toBe('ask');
    });
  });

  describe('normalizeMcpToolResult', () => {
    it('isError=true 抛 AppError(TOOL_EXECUTION_FAILED)', () => {
      const result: McpToolCallResult = {
        content: [{ type: 'text', text: '文件不存在' }],
        isError: true,
      };
      expect(() => normalizeMcpToolResult(result)).toThrow(AppError);
      try {
        normalizeMcpToolResult(result);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCode.TOOL_EXECUTION_FAILED);
        expect((error as AppError).message).toContain('文件不存在');
      }
    });

    it('isError=true 但无 text 块时仍抛错（含"未知错误"）', () => {
      const result: McpToolCallResult = {
        content: [{ type: 'image', data: '', mimeType: 'image/png' }],
        isError: true,
      };
      try {
        normalizeMcpToolResult(result);
        expect.fail('应抛错');
      } catch (error) {
        expect((error as AppError).message).toContain('未知错误');
      }
    });

    it('structuredContent 优先返回', () => {
      const result: McpToolCallResult = {
        content: [{ type: 'text', text: 'hello' }],
        structuredContent: { foo: 'bar' },
      };
      expect(normalizeMcpToolResult(result)).toEqual({ foo: 'bar' });
    });

    it('单个 text 块 → 返回字符串', () => {
      const result: McpToolCallResult = {
        content: [{ type: 'text', text: 'hello world' }],
      };
      expect(normalizeMcpToolResult(result)).toBe('hello world');
    });

    it('多个 text 块 → 换行拼接', () => {
      const result: McpToolCallResult = {
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      };
      expect(normalizeMcpToolResult(result)).toBe('line1\nline2');
    });

    it('无 text 块（仅 image/audio）→ 返回空字符串', () => {
      const result: McpToolCallResult = {
        content: [{ type: 'image', data: '', mimeType: 'image/png' }],
      };
      expect(normalizeMcpToolResult(result)).toBe('');
    });

    it('空 content 数组 → 返回空字符串', () => {
      const result: McpToolCallResult = { content: [] };
      expect(normalizeMcpToolResult(result)).toBe('');
    });
  });

  describe('adaptMcpTool', () => {
    const baseConfig: McpServerConfig = {
      name: 'filesystem',
      command: 'npx',
    };

    function makeDescriptor(
      overrides: Partial<Omit<McpToolDescriptor, 'name'>> = {},
    ): McpToolDescriptor {
      // 注意：exactOptionalPropertyTypes 下，不能显式赋 undefined，
      // 用条件展开跳过 undefined 字段
      // description 默认值；可通过 overrides.description 显式省略
      const description = overrides.description ?? '读取文件内容';
      return {
        name: 'read_file',
        ...(description !== undefined ? { description } : {}),
        inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
        ...(overrides.annotations !== undefined ? { annotations: overrides.annotations } : {}),
      };
    }

    it('工具名加命名空间前缀', () => {
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), vi.fn() as unknown as McpCallToolFn);
      expect(tool.name).toBe('mcp__filesystem__read_file');
    });

    it('description 透传 MCP server 返回的值', () => {
      const tool = adaptMcpTool(
        baseConfig,
        makeDescriptor({ description: '读取文件' }),
        vi.fn() as unknown as McpCallToolFn,
      );
      expect(tool.description).toBe('读取文件');
    });

    it('description 为空时使用 fallback 文案', () => {
      const tool = adaptMcpTool(
        baseConfig,
        {
          name: 'read_file',
          inputSchema: { type: 'object', properties: {} },
        },
        vi.fn() as unknown as McpCallToolFn,
      );
      expect(tool.description).toBe('(MCP tool from filesystem: read_file)');
    });

    it('permission 基于 readOnlyHint 决策', () => {
      const tool = adaptMcpTool(
        baseConfig,
        makeDescriptor({ annotations: { readOnlyHint: true } }),
        vi.fn() as unknown as McpCallToolFn,
      );
      expect(tool.permission).toBe('auto');
    });

    it('permission 默认 ask（无 annotations）', () => {
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), vi.fn() as unknown as McpCallToolFn);
      expect(tool.permission).toBe('ask');
    });

    it('execute 调用 callTool 回调并返回标准化结果', async () => {
      const ctx = makeCtx();
      const mockCallTool = vi.fn<McpCallToolFn>().mockResolvedValue({
        content: [{ type: 'text', text: 'file content' }],
      });
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), mockCallTool);
      const result = await tool.execute({ path: '/tmp/test.txt' }, ctx);
      expect(result.output).toBe('file content');
      expect(result.title).toContain('mcp__filesystem__read_file');
      expect(result.metadata).toBeDefined();
      // callTool 第一个参数为原始工具名（不含命名空间前缀）
      expect(mockCallTool).toHaveBeenCalledWith('read_file', { path: '/tmp/test.txt' }, ctx);
    });

    it('execute 在 abortSignal 已中断时抛 TOOL_ABORTED', async () => {
      const ctx: ToolContext = {
        workingDir: '/workspace',
        sessionId: 'session',
        messageId: 'msg-1',
        callId: 'call-1',
        abortSignal: {
          aborted: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        } as unknown as AbortSignal,
        webContents: mockWebContents,
      };
      const mockCallTool = vi.fn<McpCallToolFn>();
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), mockCallTool);
      await expect(tool.execute({}, ctx)).rejects.toMatchObject({
        code: ErrorCode.TOOL_ABORTED,
      });
      // 未调用 callTool
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('execute 转发 callTool 抛出的错误', async () => {
      const ctx = makeCtx();
      const mockCallTool = vi
        .fn<McpCallToolFn>()
        .mockRejectedValue(new AppError(ErrorCode.TOOL_EXECUTION_FAILED, 'server error'));
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), mockCallTool);
      await expect(tool.execute({}, ctx)).rejects.toMatchObject({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      });
    });

    it('inputSchema 为宽松 zod schema（z.record）', () => {
      const tool = adaptMcpTool(baseConfig, makeDescriptor(), vi.fn() as unknown as McpCallToolFn);
      // 宽松 schema 接受任意对象
      expect(tool.inputSchema.safeParse({ any: 'value' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({}).success).toBe(true);
    });
  });
});
