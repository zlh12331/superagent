// smoke.test.ts：@code-agent/shared 主入口（../index）统一导出的冒烟契约——常量值 / AppError / 类型可引用性
// 边界：只证明消费方能导入并使用；各模块自身行为由同目录分域用例覆盖
import { describe, expect, it } from 'vitest';
import type { AppStatus, IpcApi, IpcResponse } from '../index';
import { AppError, ErrorCode, IPC_CHANNELS, IPC_PROTOCOL_VERSION, SHARED_VERSION } from '../index';

describe('smoke: packages/shared 统一导出', () => {
  it('可导入常量', () => {
    // index.ts 的手写常量（与 packages/shared/package.json 的 version 不同源）：锁字面量本身，不是包版本一致性检查
    expect(SHARED_VERSION).toBe('0.1.0');
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_OPEN_EXTERNAL).toBe('app:openExternal');
    // 仅在协议破坏性变更时递增；渲染层启动时与主进程 app:getStatus 回传值比对（src/renderer/hooks/use-protocol-check.ts）
    expect(IPC_PROTOCOL_VERSION).toBe(1);
  });

  it('可使用 AppError', () => {
    const err = new AppError(ErrorCode.UNKNOWN);
    expect(err.code).toBe('UNKNOWN');
    expect(err.toIpcError().code).toBe('UNKNOWN');
  });

  it('可引用类型（编译时校验）', () => {
    // 真正的断言是类型注解（字段名/类型写错即 tsc 报错）；'data' in 收窄是渲染层消费 IpcResponse 的既有判别约定
    const status: AppStatus = { ready: true, protocolVersion: 1 };
    const resp: IpcResponse<AppStatus> = { data: status };
    expect('data' in resp).toBe(true);
    expect(resp.data?.ready).toBe(true);
  });

  it('IpcApi 接口编译时可达', () => {
    // 参数的类型注解即断言本身（IpcApi 不可达即编译期报错）；此处的 expect 只是让用例有运行时落点
    function _consume(api: IpcApi): void {
      void api;
    }
    expect(typeof _consume).toBe('function');
  });
});
