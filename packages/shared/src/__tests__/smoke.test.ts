// packages/shared/src/__tests__/smoke.test.ts
// 冒烟测试：验证统一导出可被外部消费
import { describe, expect, it } from 'vitest';
import type { IpcApi, IpcResponse, Project } from '../index';
import {
  AppError,
  ErrorCode,
  IPC_CHANNELS,
  ProjectCreateInputSchema,
  SHARED_VERSION,
} from '../index';

describe('smoke: packages/shared 统一导出', () => {
  it('可导入常量', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
    expect(IPC_CHANNELS.PROJECT_CREATE).toBe('project:create');
  });

  it('可使用 AppError', () => {
    const err = new AppError(ErrorCode.UNKNOWN);
    expect(err.code).toBe('UNKNOWN');
    expect(err.toIpcError().code).toBe('UNKNOWN');
  });

  it('可使用 Zod schema', () => {
    const parsed = ProjectCreateInputSchema.parse({ name: '测试' });
    expect(parsed.name).toBe('测试');
  });

  it('可引用类型（编译时校验）', () => {
    const resp: IpcResponse<Project> = {
      data: {
        id: 'x',
        name: 'x',
        status: 'DRAFT',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect('data' in resp).toBe(true);
  });

  it('IpcApi 接口编译时可达', () => {
    // 此函数签名仅在编译时验证类型可达
    function _consume(api: IpcApi): void {
      void api;
    }
    expect(typeof _consume).toBe('function');
  });
});
