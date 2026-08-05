// src/main/infra/ai/stall-watchdog.test.ts
// 停滞看门狗单测：无进展停滞/工具豁免/重试耗尽/父取消传播

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StallWatchdog, type WatchdogEvent } from './stall-watchdog';

describe('StallWatchdog', () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  it('正常执行：有进度事件刷新计时，不误判', async () => {
    const watchdog = new StallWatchdog({ stallMs: 50, maxAttempts: 2 });
    const result = await watchdog.guard({
      label: '正常回合',
      dispatch: async (signal, report) => {
        // 持续产出进展（每 20ms 一次，远小于 stallMs 且持续刷新）
        for (let i = 0; i < 6; i += 1) {
          if (signal.aborted) {
            break;
          }
          report({ type: 'progress' });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return '完成';
      },
    });
    expect(result).toBe('完成');
  });

  it('停滞检测：无进展超阈值 → abort 当前尝试并重试', async () => {
    const watchdog = new StallWatchdog({ stallMs: 40, maxAttempts: 3 });
    let attempts = 0;
    const events: WatchdogEvent[] = [];
    const result = await watchdog.guard({
      label: '停滞回合',
      onEvent: (event) => {
        events.push(event);
      },
      dispatch: async (signal) => {
        attempts += 1;
        // 第一次尝试：无进展挂起（等待停滞 abort）；后续尝试：立即完成
        if (attempts === 1) {
          await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (signal.aborted) {
                clearInterval(timer);
                resolve(undefined);
              }
            }, 10);
          });
          throw new Error('停滞中止');
        }
        return `第 ${attempts} 次成功`;
      },
    });
    expect(result).toBe('第 2 次成功');
    expect(attempts).toBe(2);
  });

  it('工具豁免：工具执行中暂停计时（长跑工具不误判）', async () => {
    const watchdog = new StallWatchdog({ stallMs: 40, maxAttempts: 2 });
    const result = await watchdog.guard({
      label: '长工具回合',
      dispatch: async (signal, report) => {
        report({ type: 'tool-start' });
        // 工具执行远超 stallMs（模拟长跑 shell 构建）
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (signal.aborted) {
          throw new Error('不应被停滞中止');
        }
        report({ type: 'tool-end' });
        return '工具完成';
      },
    });
    expect(result).toBe('工具完成');
  });

  it('重试耗尽：全部尝试停滞 → 抛耗尽错误', async () => {
    const watchdog = new StallWatchdog({ stallMs: 40, maxAttempts: 2 });
    await expect(
      watchdog.guard({
        label: '永远停滞',
        dispatch: async (signal) => {
          await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (signal.aborted) {
                clearInterval(timer);
                resolve(undefined);
              }
            }, 10);
          });
          throw new Error('停滞中止');
        },
      }),
    ).rejects.toThrow('停滞重试耗尽');
  });

  it('父取消：立即传播且不重试', async () => {
    const watchdog = new StallWatchdog({ stallMs: 40, maxAttempts: 3 });
    const controller = new AbortController();
    let attempts = 0;
    const promise = watchdog.guard({
      label: '取消回合',
      signal: controller.signal,
      dispatch: async (signal) => {
        attempts += 1;
        // 监听 per-attempt abort（AI SDK 真实行为：abort 即抛错）
        await new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            if (signal.aborted) {
              clearInterval(timer);
              reject(new Error('被 abort'));
            }
          }, 5);
          setTimeout(() => {
            clearInterval(timer);
            resolve(undefined);
          }, 80);
        });
        return '不应返回';
      },
    });
    // 首次尝试进行中父取消
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('父信号取消');
    expect(attempts).toBe(1);
  });

  it('委托自身失败：视为停滞重试（最后一次失败原因抛出）', async () => {
    const watchdog = new StallWatchdog({ stallMs: 1_000, maxAttempts: 2 });
    let attempts = 0;
    await expect(
      watchdog.guard({
        label: '失败回合',
        dispatch: async () => {
          attempts += 1;
          throw new Error(`失败 ${attempts}`);
        },
      }),
    ).rejects.toThrow('失败 2');
    expect(attempts).toBe(2);
  });
});
