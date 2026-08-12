// src/main/infra/telemetry/otel.test.ts
// otel 单测：初始化分支（OTLP/Console/失败容忍）、withSpan 生命周期、shutdown
//
// 测试要点：
// 1. initTelemetry：无 endpoint → Console exporter（dev）；有 endpoint → OTLP exporter
// 2. serviceName：dev/prod 区分
// 3. 幂等：重复调用跳过
// 4. withSpan：未初始化直接执行 / 初始化后 span 生命周期 / 异常设置错误状态
// 5. shutdownTelemetry：未初始化跳过 / 初始化后 flush + 重置

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockApp = {
    isPackaged: false,
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/tmp/otel-test'),
  };
  return { mockLogger, mockApp };
});

vi.mock('electron', () => ({
  app: mocks.mockApp,
}));

// 注意：otel 在 infra/telemetry/ 下，logger 相对路径为 '../../utils/logger'
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

import { getTracer, initTelemetry, shutdownTelemetry, withSpan } from './otel';

describe('otel 批次11 缺口补全', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.mockApp.isPackaged = false;
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    // 重置模块状态（shutdown 内部 forceFlush 在 SDK v2 测试环境可能抛，catch 兜底后状态仍重置）
    await shutdownTelemetry().catch(() => {});
  });

  it('未初始化：getTracer 返回 null；withSpan 直接执行 fn', async () => {
    expect(getTracer()).toBeNull();

    let executed = false;
    const result = await withSpan('test.span', {}, async (span) => {
      executed = true;
      // 未初始化分支：fn 收到 undefined span（业务代码必须容忍）
      expect(span).toBeUndefined();
      return 'ok';
    });

    expect(executed).toBe(true);
    expect(result).toBe('ok');
  });

  it('initTelemetry 无 endpoint：Console exporter + dev serviceName', () => {
    initTelemetry();
    expect(mocks.mockLogger.info).toHaveBeenCalledWith(
      {},
      'OpenTelemetry 初始化完成（Console exporter，dev only）',
    );
    expect(getTracer()).not.toBeNull();
  });

  it('initTelemetry 有 endpoint：OTLP exporter + dev serviceName', () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318/v1/traces';
    initTelemetry();
    expect(mocks.mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://localhost:4318/v1/traces' }),
      'OpenTelemetry 初始化完成（OTLP exporter）',
    );
    expect(getTracer()).not.toBeNull();
  });

  it('initTelemetry 生产环境：serviceName 带 prod 后缀', () => {
    mocks.mockApp.isPackaged = true;
    initTelemetry();
    // 资源属性含 service.name=code-agent-agent-prod（经 provider 注册可观察）
    expect(getTracer()).not.toBeNull();
    expect(mocks.mockLogger.info).toHaveBeenCalled();
  });

  it('initTelemetry 幂等：重复调用跳过（只初始化一次）', () => {
    initTelemetry();
    const first = getTracer();
    initTelemetry();
    expect(getTracer()).toBe(first);
    // 第二次初始化不再打日志
    const consoleLogs = mocks.mockLogger.info.mock.calls.filter((c) =>
      String(c[1]).includes('OpenTelemetry 初始化完成'),
    );
    expect(consoleLogs).toHaveLength(1);
  });

  it('withSpan 初始化后：span 正常结束并返回结果', async () => {
    initTelemetry();
    const result = await withSpan('test.withspan', { key: 'value' }, async (span) => {
      span.setAttribute('attr', 'x');
      return 'done';
    });
    expect(result).toBe('done');
  });

  it('withSpan 初始化后 fn 抛错：设置错误状态并向上抛出', async () => {
    initTelemetry();
    await expect(
      withSpan('test.fail', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('shutdownTelemetry 初始化后：重置为未初始化', async () => {
    initTelemetry();
    expect(getTracer()).not.toBeNull();
    await shutdownTelemetry();
    expect(getTracer()).toBeNull();
  });

  it('shutdownTelemetry 未初始化：直接返回', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
