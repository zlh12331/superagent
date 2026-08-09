// src/main/infra/ai/hook-registry.test.ts
// 钩子注册表单测：注册/取消/阻断/错误隔离

import { describe, expect, it, vi } from 'vitest';
import { HookEventName, HookRegistry } from './agent/hook-registry';

describe('HookRegistry', () => {
  it('注册 + 触发：handler 收到上下文', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn(() => true);
    registry.register(HookEventName.PRE_TOOL_USE, handler);

    const allow = await registry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'read_file',
      input: {},
    });
    expect(allow).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'read_file', sessionId: 's1' }),
    );
  });

  it('pre-tool-use 返回 false：阻断执行（allow=false）', async () => {
    const registry = new HookRegistry();
    registry.register(HookEventName.PRE_TOOL_USE, () => false);
    const allow = await registry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'write_file',
      input: {},
    });
    expect(allow).toBe(false);
  });

  it('无钩子注册：默认放行', async () => {
    const registry = new HookRegistry();
    const allow = await registry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'x',
      input: {},
    });
    expect(allow).toBe(true);
  });

  it('错误隔离：单个钩子抛错不阻断其他钩子', async () => {
    const registry = new HookRegistry();
    registry.register(HookEventName.POST_TOOL_USE, () => {
      throw new Error('hook boom');
    });
    const goodHandler = vi.fn(() => true);
    registry.register(HookEventName.POST_TOOL_USE, goodHandler);

    const allow = await registry.trigger(HookEventName.POST_TOOL_USE, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'x',
      input: {},
    });
    expect(allow).toBe(true);
    expect(goodHandler).toHaveBeenCalled();
  });

  it('取消注册：unsubscribe 后不再触发', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn(() => true);
    const unsubscribe = registry.register(HookEventName.PRE_TOOL_USE, handler);
    unsubscribe();
    await registry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'x',
      input: {},
    });
    expect(handler).not.toHaveBeenCalled();
    expect(registry.getHandlerCount()).toBe(0);
  });
});
