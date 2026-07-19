// src/main/__tests__/ollama-controller.test.ts
// ollama-controller 单元测试
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockChildProcess, mockFetch } = vi.hoisted(() => {
  const mockChildProcess = {
    pid: 67890,
    killed: false,
    kill: vi.fn((_signal?: string) => {
      mockChildProcess.killed = true;
      setTimeout(() => {
        mockChildProcess.listeners?.exit?.(0, null);
      }, 10);
      return true;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!mockChildProcess.listeners) mockChildProcess.listeners = {};
      mockChildProcess.listeners[event] = listener;
    }),
    // stop() 使用 child.once('exit', ...)，需要 mock 实现
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!mockChildProcess.listeners) mockChildProcess.listeners = {};
      mockChildProcess.listeners[event] = listener;
    }),
    stdout: {
      on: vi.fn((event: string, listener: (chunk: Buffer) => void) => {
        if (!mockChildProcess.stdoutListeners) mockChildProcess.stdoutListeners = {};
        mockChildProcess.stdoutListeners[event] = listener;
      }),
    },
    stderr: { on: vi.fn() },
    listeners: {} as Record<string, (...args: unknown[]) => void>,
    stdoutListeners: {} as Record<string, (chunk: Buffer) => void>,
  };
  const mockSpawn = vi.fn(() => mockChildProcess);
  const mockFetch = vi.fn();
  return { mockSpawn, mockChildProcess, mockFetch };
});

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
// mock global fetch
globalThis.fetch = mockFetch as unknown as typeof fetch;

import { OllamaController } from '../infra/ai/ollama-controller';

describe('OllamaController', () => {
  let controller: OllamaController;

  beforeEach(() => {
    vi.clearAllMocks();
    // mockFetch 用 mockReset 清空 once 队列与默认实现，
    // 避免上一个测试遗留的 mockResolvedValueOnce 污染下一个测试的 start() 探活
    mockFetch.mockReset();
    mockChildProcess.killed = false;
    mockChildProcess.listeners = {};
    mockChildProcess.stdoutListeners = {};
    controller = new OllamaController({
      binaryPath: 'ollama',
      host: 'localhost',
      port: 11434,
      embedModel: 'nemotron-3-embed-1b-bf16',
      maxRestartCount: 3,
    });
  });

  afterEach(() => {
    controller.removeAllListeners();
  });

  it('start() 探活已运行 Ollama 时复用，不 spawn', async () => {
    // 模拟 Ollama 已运行（/api/tags 返回 200）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'nemotron-3-embed-1b-bf16' }] }),
    } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(statusListener).toHaveBeenCalledWith({ status: 'running' });
  });

  it('start() 探活失败时 spawn ollama serve', async () => {
    // 第一次探活失败（未运行），第二次成功（启动后）
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).toHaveBeenCalledWith('ollama', ['serve'], expect.anything());
    expect(statusListener).toHaveBeenCalledWith({ status: 'running' });
  });

  it('start() spawn 后端口仍不可达时抛 OLLAMA_NOT_RUNNING', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    // 使用 fake timers 加速 waitForHealth 的 30 次重试（30s × 1s 间隔）
    vi.useFakeTimers();
    const startPromise = controller.start();
    // 先附加 rejection 断言，避免推进定时器时 start() 拒绝产生未处理拒绝
    const rejectionAssertion = expect(startPromise).rejects.toThrow();
    // 推进 35 秒，覆盖全部 30 次重试
    await vi.advanceTimersByTimeAsync(35000);
    await rejectionAssertion;
    vi.useRealTimers();
    expect(mockChildProcess.kill).toHaveBeenCalled();
  });

  it('ensureModelPulled 模型已存在时直接返回', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'nemotron-3-embed-1b-bf16' }] }),
    } as Response);

    await controller.ensureModelPulled();
    // 不应该 spawn pull 进程
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('ensureModelPulled 模型不存在时 spawn ollama pull 并推送进度', async () => {
    // 第一次：检查模型列表，模型不存在
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response)
      // ensureModelPulled 内部再次探活已运行
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response);

    const progressListener = vi.fn();
    controller.on('pull-progress', progressListener);

    // 模拟 pull 进程输出进度 JSON
    const pullPromise = controller.ensureModelPulled();

    // 触发 stdout 模拟 ollama pull 输出
    setTimeout(() => {
      mockChildProcess.stdoutListeners.data?.(
        Buffer.from('{"status":"pulling","completed":50,"total":100}\n'),
      );
      mockChildProcess.stdoutListeners.data?.(
        Buffer.from('{"status":"success","completed":100,"total":100}\n'),
      );
      mockChildProcess.listeners.exit?.(0, null);
    }, 10);

    await pullPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'ollama',
      ['pull', 'nemotron-3-embed-1b-bf16'],
      expect.anything(),
    );
    expect(progressListener).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 50, total: 100 }),
    );
  });

  it('stop() 停止 Ollama 进程', async () => {
    // 先启动（spawn 路径）
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) } as Response);

    await controller.start();
    await controller.stop();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('进程崩溃时发射 crashed 状态', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) } as Response);

    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();
    // 模拟进程崩溃
    mockChildProcess.listeners.exit?.(1, null);

    expect(statusListener).toHaveBeenCalledWith({ status: 'crashed', code: 1 });
  });
});
