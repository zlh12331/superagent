import { describe, expect, it } from 'vitest';
import type { IpcApi } from '../ipc/api';

describe('IpcApi interface', () => {
  it('包含应用级域', () => {
    const domains: Array<keyof IpcApi> = ['app'];
    expect(domains.length).toBe(1);
  });

  it('app 域含基础方法', () => {
    type AppApi = IpcApi['app'];
    const methods: Array<keyof AppApi> = ['getStatus', 'openExternal'];
    expect(methods.length).toBe(2);
  });
});
