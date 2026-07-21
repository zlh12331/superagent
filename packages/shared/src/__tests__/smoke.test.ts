// packages/shared/src/__tests__/smoke.test.ts
// 冒烟测试：验证统一导出可被外部消费
import { describe, expect, it } from 'vitest';
import type { AppStatus, IpcApi, IpcResponse } from '../index';
import { AppError, ErrorCode, IPC_CHANNELS, SHARED_VERSION } from '../index';

describe('smoke: packages/shared 统一导出', () => {
  it('可导入常量', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_OPEN_EXTERNAL).toBe('app:openExternal');
  });

  it('可使用 AppError', () => {
    const err = new AppError(ErrorCode.UNKNOWN);
    expect(err.code).toBe('UNKNOWN');
    expect(err.toIpcError().code).toBe('UNKNOWN');
  });

  it('可引用类型（编译时校验）', () => {
    const status: AppStatus = { ready: true };
    const resp: IpcResponse<AppStatus> = { data: status };
    expect('data' in resp).toBe(true);
    expect(resp.data?.ready).toBe(true);
  });

  it('IpcApi 接口编译时可达', () => {
    // 此函数签名仅在编译时验证类型可达
    function _consume(api: IpcApi): void {
      void api;
    }
    expect(typeof _consume).toBe('function');
  });
});
