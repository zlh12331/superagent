// src/renderer/stores/persistent/settings-store.test.ts
// settings-store 的 applyMainSettingChange 单测
// ──────────────────────────────────────────────────────────────
// 该 action 服务于「主进程主动变更设置」（托盘菜单改关窗行为），核心不变量有两条：
//   1. 按域合并，**不得**影响其它域（整体替换会把 theme/language 等打回默认值）
//   2. 只更新内存态、**不回写**（变更来源是主进程，回写是回声）
// 见 docs/design/30-residency-fix-spec.md §3 P2-6 / §4.7d。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 断言"不回写"：拦截 settings:set IPC
const setSpy = vi.fn(async () => ({ data: { ok: true } }));
Object.defineProperty(window, 'api', {
  value: { settings: { set: setSpy } },
  writable: true,
  configurable: true,
});

import { useSettingsStore } from './settings-store';

/** store 的初始默认值（DEFAULT_SETTINGS 为模块私有；此处按已知默认态复位） */
const DEFAULTS = { theme: 'dark', language: 'zh-CN', closeAction: 'minimize' } as const;

describe('settings-store.applyMainSettingChange', () => {
  beforeEach(() => {
    setSpy.mockClear();
    // 复位到默认态（各用例独立）
    useSettingsStore.setState({
      theme: DEFAULTS.theme,
      language: DEFAULTS.language,
      window: { closeAction: DEFAULTS.closeAction },
    });
  });

  it('window 域：应用主进程传入的 closeAction', () => {
    useSettingsStore.getState().applyMainSettingChange('window', { closeAction: 'quit' });
    expect(useSettingsStore.getState().window.closeAction).toBe('quit');
  });

  it('不回写：不调用 settings:set（变更来源是主进程，回写是回声）', () => {
    useSettingsStore.getState().applyMainSettingChange('window', { closeAction: 'quit' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('按域合并：其它域不受影响（整体替换会打回默认值——这是不能复用 applySettingsSnapshot 的原因）', () => {
    useSettingsStore.setState({ theme: 'light', language: 'en' });

    useSettingsStore.getState().applyMainSettingChange('window', { closeAction: 'quit' });

    expect(useSettingsStore.getState().theme).toBe('light');
    expect(useSettingsStore.getState().language).toBe('en');
    expect(useSettingsStore.getState().window.closeAction).toBe('quit');
  });

  it('window 域的部分字段：与既有字段合并而非替换', () => {
    // 预置同域其它字段（未来 window 域扩展时不应被抹掉）
    useSettingsStore.setState({
      window: { closeAction: 'minimize', ...{ futureField: 'x' } } as never,
    });

    useSettingsStore.getState().applyMainSettingChange('window', { closeAction: 'quit' });

    const win = useSettingsStore.getState().window as unknown as Record<string, unknown>;
    expect(win['closeAction']).toBe('quit');
    expect(win['futureField']).toBe('x');
  });

  it('非对象值被忽略（不让主进程的异常 payload 污染 state）', () => {
    const before = useSettingsStore.getState().window;

    useSettingsStore.getState().applyMainSettingChange('window', 'not-an-object');
    useSettingsStore.getState().applyMainSettingChange('window', null);

    expect(useSettingsStore.getState().window).toEqual(before);
  });

  it('未知/非对象域被忽略，不抛错也不新增键', () => {
    const before = useSettingsStore.getState();

    useSettingsStore.getState().applyMainSettingChange('theme', { bogus: 1 });
    expect(useSettingsStore.getState().theme).toBe(before.theme);

    useSettingsStore.getState().applyMainSettingChange('ai', 42);
    expect(useSettingsStore.getState().ai).toEqual(before.ai);
  });
});
