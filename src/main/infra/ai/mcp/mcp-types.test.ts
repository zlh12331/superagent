// src/main/infra/ai/mcp/mcp-types.test.ts
// mcp-types 单测：命名空间 helper 函数
//
// 测试要点：
// 1. buildMcpToolName：构建 mcp__${serverName}__${toolName}
// 2. isMcpTool：判断是否以 mcp__ 开头
// 3. parseMcpToolName：解析命名空间名称为 { serverName, toolName }

import { describe, expect, it } from 'vitest';

import { buildMcpToolName, isMcpTool, parseMcpToolName } from './mcp-types';

describe('mcp-types', () => {
  describe('buildMcpToolName', () => {
    it('构建标准命名空间名称', () => {
      expect(buildMcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
    });

    it('serverName 和 toolName 均为空时仍构建前缀', () => {
      expect(buildMcpToolName('', '')).toBe('mcp____');
    });

    it('toolName 包含下划线时正常拼接', () => {
      expect(buildMcpToolName('git', 'create_branch')).toBe('mcp__git__create_branch');
    });
  });

  describe('isMcpTool', () => {
    it('mcp__ 开头返回 true', () => {
      expect(isMcpTool('mcp__filesystem__read_file')).toBe(true);
    });

    it('非 mcp__ 开头返回 false', () => {
      expect(isMcpTool('read_file')).toBe(false);
      expect(isMcpTool('write_file')).toBe(false);
    });

    it('空字符串返回 false', () => {
      expect(isMcpTool('')).toBe(false);
    });

    it('仅前缀 mcp__ 也返回 true', () => {
      expect(isMcpTool('mcp__')).toBe(true);
    });
  });

  describe('parseMcpToolName', () => {
    it('正常命名空间名称解析为 { serverName, toolName }', () => {
      expect(parseMcpToolName('mcp__filesystem__read_file')).toEqual({
        serverName: 'filesystem',
        toolName: 'read_file',
      });
    });

    it('toolName 包含双下划线时仅切分第一个', () => {
      // 仅切分第一个 __，后续 __ 归入 toolName
      expect(parseMcpToolName('mcp__git__create__branch')).toEqual({
        serverName: 'git',
        toolName: 'create__branch',
      });
    });

    it('非 mcp__ 前缀返回 undefined', () => {
      expect(parseMcpToolName('read_file')).toBeUndefined();
      expect(parseMcpToolName('filesystem__read_file')).toBeUndefined();
    });

    it('仅前缀 mcp__ 无分隔符返回 undefined', () => {
      expect(parseMcpToolName('mcp__')).toBeUndefined();
    });

    it('serverName 为空（mcp____tool）返回 undefined', () => {
      // sepIdx <= 0：第一个 __ 在位置 0，表示 serverName 为空
      expect(parseMcpToolName('mcp____tool')).toBeUndefined();
    });

    it('toolName 为空（mcp__server__）返回 undefined', () => {
      // sepIdx >= rest.length - 2：分隔符后没有 toolName
      expect(parseMcpToolName('mcp__server__')).toBeUndefined();
    });
  });
});
