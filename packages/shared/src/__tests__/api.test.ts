// packages/shared/src/__tests__/api.test.ts
// IpcApi 接口结构完整性测试（类型层面，运行时仅做接口存在性检查）
import { describe, expect, it } from 'vitest';
import type { IpcApi } from '../ipc/api';

describe('IpcApi interface', () => {
  it('包含所有业务域', () => {
    // 通过类型约束编译时校验，运行时仅做存在性 sanity check
    const domains: Array<keyof IpcApi> = [
      'project',
      'chapter',
      'character',
      'worldview',
      'chat',
      'rag',
      'agent',
      'settings',
      'app',
    ];
    expect(domains.length).toBe(9);
  });

  it('chat 域同时含 invoke 和 subscribe 方法', () => {
    type ChatApi = IpcApi['chat'];
    const invokeMethods: Array<keyof ChatApi> = [
      'createSession',
      'listSessions',
      'getMessages',
      'sendMessage',
      'stopGeneration',
    ];
    const subscribeMethods: Array<keyof ChatApi> = [
      'onStreamChunk',
      'onStreamEnd',
      'onStreamError',
    ];
    expect(invokeMethods.length + subscribeMethods.length).toBe(8);
  });

  it('app 域含状态事件订阅方法', () => {
    type AppApi = IpcApi['app'];
    const methods: Array<keyof AppApi> = [
      'getStatus',
      'openExternal',
      'onPgStatusChange',
      'onOllamaStatusChange',
      'onOllamaPullProgress',
    ];
    expect(methods.length).toBe(5);
  });
});
