// src/renderer/test/__tests__/mock-api.test.ts
// MSW IPC mock 工厂集成测试
// ──────────────────────────────────────────────────────────────
// 职责：
// - 验证 createMockApi() 工厂可用
// - 验证 ok() / err() 响应构造器正确
// - 验证 mock 可被覆盖
//
// 此测试验证 mock 工厂本身，不测试业务逻辑。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  createMockApi,
  err,
  gitMocks,
  logsMocks,
  ok,
  sessionMocks,
  settingsMocks,
  systemMocks,
  terminalMocks,
} from '../msw-handlers';

describe('IPC mock 工厂', () => {
  it('ok() 返回 { data } 形状', () => {
    const response = ok({ foo: 'bar' });
    expect('data' in response).toBe(true);
    if ('data' in response) {
      expect(response.data).toEqual({ foo: 'bar' });
    }
  });

  it('err() 返回 { error: { code, message } } 形状', () => {
    const response = err('TEST_ERROR', '测试错误');
    expect('error' in response).toBe(true);
    if ('error' in response) {
      expect(response.error?.code).toBe('TEST_ERROR');
      expect(response.error?.message).toBe('测试错误');
    }
  });

  it('createMockApi() 返回所有 14 个域', () => {
    const api = createMockApi();
    const domains = Object.keys(api);
    expect(domains).toContain('app');
    expect(domains).toContain('chat');
    expect(domains).toContain('agent');
    expect(domains).toContain('session');
    expect(domains).toContain('file');
    expect(domains).toContain('search');
    expect(domains).toContain('terminal');
    expect(domains).toContain('git');
    expect(domains).toContain('codebase');
    expect(domains).toContain('tool');
    expect(domains).toContain('settings');
    expect(domains).toContain('system');
    expect(domains).toContain('logs');
    expect(domains).toContain('devtools');
  });

  it('createMockApi() 所有方法是 function', () => {
    const api = createMockApi();
    expect(typeof api.session.list).toBe('function');
    expect(typeof api.system.getStatus).toBe('function');
    expect(typeof api.settings.getApiKey).toBe('function');
  });

  it('session.list mock 返回测试会话', async () => {
    const api = createMockApi();
    const response = await api.session.list({ limit: 50, offset: 0 });
    expect('data' in response).toBe(true);
    if ('data' in response) {
      const data = response.data as { sessions: unknown[]; total: number };
      expect(data.total).toBe(1);
    }
  });

  it('system.getStatus mock 返回 ready=true', async () => {
    const api = createMockApi();
    const response = await api.system.getStatus(undefined as never);
    if ('data' in response) {
      const data = response.data as { ready: boolean };
      expect(data.ready).toBe(true);
    }
  });

  it('git.status mock 返回 main 分支', async () => {
    const api = createMockApi();
    const response = await api.git.status({});
    if ('data' in response) {
      const data = response.data as { branch: string };
      expect(data.branch).toBe('main');
    }
  });

  it('settings.getTelemetryLevel mock 返回 full', async () => {
    const api = createMockApi();
    const response = await api.settings.getTelemetryLevel(undefined as never);
    if ('data' in response) {
      const data = response.data as { level: string };
      expect(data.level).toBe('full');
    }
  });

  it('各 domain mock 工厂返回正确结构', () => {
    expect('data' in systemMocks.getStatus()).toBe(true);
    expect('data' in sessionMocks.list()).toBe(true);
    expect('data' in gitMocks.status()).toBe(true);
    expect('data' in settingsMocks.getTelemetryLevel()).toBe(true);
    expect('data' in logsMocks.read()).toBe(true);
    expect('data' in terminalMocks.create()).toBe(true);
  });
});
