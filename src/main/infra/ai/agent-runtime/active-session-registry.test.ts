// src/main/infra/ai/agent-runtime/active-session-registry.test.ts
// ActiveSessionRegistry 单元测试
// 覆盖：activeCount（关窗协商的判定依据）+ 注册/中断/CAS 删除/dispose 语义回归
import { describe, expect, it, vi } from 'vitest';

// logger 依赖 electron（app.getPath）——测试环境按项目惯例 mock electron
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp/test-userdata') },
}));

import { ActiveSessionRegistry } from './active-session-registry';

/** 造一个恒 pending 的 stream Promise（模拟活跃 stream，dispose 需超时兜底） */
function pendingStream(): Promise<void> {
  return new Promise<void>(() => {});
}

describe('ActiveSessionRegistry', () => {
  it('初始 activeCount 为 0（无回合时不打扰关窗协商）', () => {
    const registry = new ActiveSessionRegistry();
    expect(registry.activeCount).toBe(0);
  });

  it('register 后 activeCount 递增，多会话并发计数正确', () => {
    const registry = new ActiveSessionRegistry();
    registry.register('s1', new AbortController(), pendingStream());
    registry.register('s2', new AbortController(), pendingStream());
    expect(registry.activeCount).toBe(2);
  });

  it('abort 后 activeCount 归零（关窗协商判定及时收口）', () => {
    const registry = new ActiveSessionRegistry();
    registry.register('s1', new AbortController(), pendingStream());
    expect(registry.abort('s1')).toBe(true);
    expect(registry.activeCount).toBe(0);
    expect(registry.getController('s1')).toBeUndefined();
  });

  it('removeControllerIfCurrent：CAS 语义防止误删新会话（旧 stream finally 迟到）', () => {
    const registry = new ActiveSessionRegistry();
    const oldController = new AbortController();
    registry.register('s1', oldController, pendingStream());
    // 新回合抢占：register 覆盖同 id 条目
    const newController = new AbortController();
    registry.register('s1', newController, pendingStream());
    // 旧 stream 的 finally 迟到：只应删自己的条目（不匹配 → false）
    expect(registry.removeControllerIfCurrent('s1', oldController)).toBe(false);
    expect(registry.activeCount).toBe(1);
    // 新 stream 正常收尾：匹配 → 删除
    expect(registry.removeControllerIfCurrent('s1', newController)).toBe(true);
    expect(registry.activeCount).toBe(0);
  });

  it('dispose 后 activeCount 归零（超时强清场景）', async () => {
    const registry = new ActiveSessionRegistry();
    registry.register('s1', new AbortController(), pendingStream());
    registry.register('s2', new AbortController(), pendingStream());
    // pendingStream 永不完成 → 走 10ms 超时兜底路径（不用默认 3s，测试提速）
    await registry.dispose(10);
    expect(registry.activeCount).toBe(0);
  });

  it('dispose 在全部 stream 完成时不清日志告警分支（正常收尾路径）', async () => {
    const registry = new ActiveSessionRegistry();
    const controller = new AbortController();
    // abort 信号触发的 stream 立即完成：dispose 无需等超时
    const stream = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        resolve();
      });
    });
    registry.register('s1', controller, stream);
    await registry.dispose(50);
    expect(registry.activeCount).toBe(0);
  });

  it('preemptExisting 对无活跃会话是 no-op（不抛错）', async () => {
    const registry = new ActiveSessionRegistry();
    await expect(registry.preemptExisting('s-unknown', 'agent')).resolves.toBeUndefined();
    expect(registry.activeCount).toBe(0);
  });
});
