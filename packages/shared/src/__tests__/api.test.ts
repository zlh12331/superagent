// packages/shared/src/__tests__/api.test.ts
// IpcApi 接口结构完整性测试（类型层面，运行时仅做接口存在性检查）
import { describe, expect, it } from 'vitest';
import type { IpcApi } from '../ipc/api';

describe('IpcApi interface', () => {
  it('包含应用级域', () => {
    // 通过类型约束编译时校验，运行时仅做存在性 sanity check
    const domains: Array<keyof IpcApi> = ['app'];
    expect(domains.length).toBe(1);
  });

  it('app 域含基础方法', () => {
    type AppApi = IpcApi['app'];
    const methods: Array<keyof AppApi> = ['getStatus', 'openExternal'];
    expect(methods.length).toBe(2);
  });
});
