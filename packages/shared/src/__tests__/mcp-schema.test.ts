// packages/shared/src/__tests__/mcp-schema.test.ts
// MCP schema 单测：transport 三态条件校验 / 向后兼容（无 transport 字段 = stdio）

import { describe, expect, it } from 'vitest';
import { McpServerConfigSchema } from '../schemas/mcp';

describe('McpServerConfigSchema', () => {
  describe('stdio（缺省，向后兼容）', () => {
    it('无 transport 字段：按 stdio 校验，command 合法通过', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.transport).toBeUndefined();
        expect(result.data.command).toBe('npx');
      }
    });

    it('显式 transport=stdio：空 command 报错', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'x',
        transport: 'stdio',
        command: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('command 不能为空');
      }
    });

    it('P0 安全：command 含路径分隔符报错', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'x',
        command: 'C:\\Windows\\cmd.exe',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('裸可执行文件名');
      }
    });
  });

  describe('sse / streamable-http（远程）', () => {
    it('streamable-http：合法 https url + headers 通过，command 允许为空', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
          Authorization: 'Bearer token-1',
        },
        command: '',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('https://mcp.example.com/mcp');
        expect(result.data.headers?.['Authorization']).toBe('Bearer token-1');
      }
    });

    it('sse：缺 url 报错', () => {
      const result = McpServerConfigSchema.safeParse({ name: 'x', transport: 'sse' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('需要提供 url');
      }
    });

    it('url 非 http(s) 协议（ftp:）报错', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'x',
        transport: 'streamable-http',
        url: 'ftp://files.example.com',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('http(s)');
      }
    });

    it('url 非法格式报错', () => {
      const result = McpServerConfigSchema.safeParse({
        name: 'x',
        transport: 'sse',
        url: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });
  });
});
