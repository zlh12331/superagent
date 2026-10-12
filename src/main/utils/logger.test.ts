import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLog } = vi.hoisted(() => {
  const mockLog = {
    level: 'info',
    transports: {
      file: { level: 'info', maxRetries: 0, fileName: 'main.log' },
      console: { level: 'debug' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    initialize: vi.fn(),
  };
  return { mockLog };
});

vi.mock('electron-log', () => ({ default: mockLog }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/test-userdata') },
}));

import { flushPendingLogs, initLogger, logger, registerGlobalErrorHandlers } from './logger';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('暴露 info/warn/error/debug 方法', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('info 日志携带 traceId 字段', () => {
    initLogger();
    logger.info({ traceId: 'test-trace-123', channel: 'project:create' }, 'IPC 请求开始');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'test-trace-123',
        channel: 'project:create',
        message: 'IPC 请求开始',
      }),
    );
  });

  it('error 日志支持 Error 对象', () => {
    const err = new Error('测试错误');
    logger.error({ traceId: 't1' }, '操作失败', err);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('registerGlobalErrorHandlers 注册 process 事件', () => {
    const onSpy = vi.spyOn(process, 'on');
    registerGlobalErrorHandlers();
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    onSpy.mockRestore();
  });

  it('测试环境重定向日志路径（回归锚：曾把测试夹具写进真实用户日志目录）', () => {
    initLogger();
    const fileTransport = mockLog.transports.file as unknown as {
      resolvePathFn?: () => string;
    };
    expect(typeof fileTransport.resolvePathFn).toBe('function');
    const resolved = fileTransport.resolvePathFn?.() ?? '';
    expect(resolved).toContain('code-agent-test-logs');
    expect(resolved).not.toContain('code-agent-desktop');
  });

  it('flushPendingLogs：electron-log 无 getFile（内部结构变化/测试 mock）时立即返回', async () => {
    await expect(flushPendingLogs(50)).resolves.toBeUndefined();
  });

  it('flushPendingLogs：轮询等待队列清空后返回', async () => {
    const fileState = { asyncWriteQueue: ['log line'], hasActiveAsyncWriting: true };
    const fileTransport = mockLog.transports.file as { getFile?: () => unknown };
    fileTransport.getFile = () => {
      fileState.asyncWriteQueue = [];
      fileState.hasActiveAsyncWriting = false;
      return fileState;
    };
    await expect(flushPendingLogs(2_000)).resolves.toBeUndefined();
    delete fileTransport.getFile;
  });
});
