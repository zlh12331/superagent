// src/renderer/stores/transient/reasoning-collapse-store.test.ts
// 折叠态覆盖 store（纯状态逻辑，无 mock）

import { beforeEach, describe, expect, it } from 'vitest';
import { useReasoningCollapseStore } from './reasoning-collapse-store';

describe('reasoning-collapse-store', () => {
  beforeEach(() => {
    useReasoningCollapseStore.setState({ overrides: new Map() });
  });

  it('未覆盖的 key 读取为 undefined（跟随 settings 默认）', () => {
    expect(useReasoningCollapseStore.getState().overrides.get('msg-1:0')).toBeUndefined();
  });

  it('不同 key 的覆盖互不影响（part 级隔离）', () => {
    const { setCollapsed } = useReasoningCollapseStore.getState();
    setCollapsed('msg-1:0', true);
    setCollapsed('msg-1:1', false);
    setCollapsed('msg-2:0', true);
    const { overrides } = useReasoningCollapseStore.getState();
    expect(overrides.get('msg-1:0')).toBe(true);
    expect(overrides.get('msg-1:1')).toBe(false);
    expect(overrides.get('msg-2:0')).toBe(true);
  });

  it('重复写入同 key 覆盖旧值；null 清除覆盖', () => {
    const { setCollapsed } = useReasoningCollapseStore.getState();
    setCollapsed('msg-1:0', true);
    setCollapsed('msg-1:0', false);
    expect(useReasoningCollapseStore.getState().overrides.get('msg-1:0')).toBe(false);
    setCollapsed('msg-1:0', null);
    expect(useReasoningCollapseStore.getState().overrides.get('msg-1:0')).toBeUndefined();
  });

  it('清除不存在的 key 不报错且不动其他条目', () => {
    const { setCollapsed } = useReasoningCollapseStore.getState();
    setCollapsed('msg-1:0', true);
    setCollapsed('msg-9:9', null);
    expect(useReasoningCollapseStore.getState().overrides.get('msg-1:0')).toBe(true);
    expect(useReasoningCollapseStore.getState().overrides.size).toBe(1);
  });
});
