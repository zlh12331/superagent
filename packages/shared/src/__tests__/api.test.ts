// api.test.ts：IpcApi（派生自 IPC_DEFINITIONS 的 window.api 形状）的抽样存在性断言——覆盖 app 域及其两个方法
// 边界：只查域/方法键是否仍存在，不校验方法签名与返回值
import { describe, expect, it } from 'vitest';
import type { IpcApi } from '../ipc/api';

describe('IpcApi interface', () => {
  it('包含应用级域', () => {
    // 真正的检查在类型注解：字面量成员不在 keyof IpcApi 内即编译期报错，toBe 只是存在性兜底
    const domains: Array<keyof IpcApi> = ['app'];
    expect(domains.length).toBe(1);
  });

  it('app 域含基础方法', () => {
    type AppApi = IpcApi['app'];
    const methods: Array<keyof AppApi> = ['getStatus', 'openExternal'];
    expect(methods.length).toBe(2);
  });
});
