// src/main/infra/memory-hub/engine-env.test.ts
// 引擎子进程环境构造单测：锁定 tsx 注入路径（NODE_OPTIONS）不被改回 execArgv
//
// 背景：2026-09-14 实测 Electron utilityProcess 不透传 execArgv 的 --import，
// 导致 tsx 未加载、子进程 ~150ms 退出码 1、引擎静默降级为空实现（见 engine-env.ts 头注释）。
// 本测试锁住"useTsx 时必须经 NODE_OPTIONS 注入 tsx"这一契约。

import { describe, expect, it } from 'vitest';
import { buildEngineEnv, TSX_NODE_OPTIONS_VALUE } from './engine-env';

describe('buildEngineEnv', () => {
  const base = {
    // biome-ignore lint/style/useNamingConvention: 上游约定环境变量名
    MEMORY_HUB_ENTRY: '/hub/src/gateway/server.ts',
    // biome-ignore lint/style/useNamingConvention: 上游约定环境变量名
    TDAI_DEPLOY_MODE: 'standalone',
    // biome-ignore lint/style/useNamingConvention: 标准环境变量名
    NODE_OPTIONS: '',
  };

  it('useTsx=true：NODE_OPTIONS 注入 --import tsx（utilityProcess 唯一的加载路径）', () => {
    const env = buildEngineEnv(base, true);
    expect(env['NODE_OPTIONS']).toBe(TSX_NODE_OPTIONS_VALUE);
    expect(env['NODE_OPTIONS']).toContain('--import');
    expect(env['NODE_OPTIONS']).toContain('tsx');
  });

  it('useTsx=false：NODE_OPTIONS 保持调用方给定值（不注入 tsx）', () => {
    const env = buildEngineEnv(base, false);
    expect(env['NODE_OPTIONS']).toBe('');
    expect(env['NODE_OPTIONS']).not.toContain('tsx');
  });

  it('上游约定的环境变量原样保留（仅覆盖 NODE_OPTIONS）', () => {
    for (const useTsx of [true, false]) {
      const env = buildEngineEnv(base, useTsx);
      expect(env['MEMORY_HUB_ENTRY']).toBe(base.MEMORY_HUB_ENTRY);
      expect(env['TDAI_DEPLOY_MODE']).toBe('standalone');
    }
  });

  it('返回新对象（不修改入参，避免调用方环境被就地改写）', () => {
    const input = { ...base };
    const env = buildEngineEnv(input, true);
    expect(env).not.toBe(input);
    expect(input['NODE_OPTIONS']).toBe('');
  });
});
