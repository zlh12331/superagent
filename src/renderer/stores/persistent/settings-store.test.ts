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

import { applySettingsSnapshot, flushPendingSettings, useSettingsStore } from './settings-store';

/** store 的初始默认值（DEFAULT_SETTINGS 为模块私有；此处按已知默认态复位） */
const DEFAULTS = { theme: 'dark', language: 'zh-CN', closeAction: 'minimize' } as const;

describe('settings-store.applyMainSettingChange', () => {
  beforeEach(() => {
    // setup.ts 的 afterEach 会重建 window.api 空骨架，这里重新挂上 spy
    Object.defineProperty(window, 'api', {
      value: { settings: { set: setSpy } },
      writable: true,
      configurable: true,
    });
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

  it('theme primitive：应用合法值且不回写（此前被 typeof value !== object 丢弃）', () => {
    useSettingsStore.getState().applyMainSettingChange('theme', 'light');
    expect(useSettingsStore.getState().theme).toBe('light');
    useSettingsStore.getState().applyMainSettingChange('theme', 'system');
    expect(useSettingsStore.getState().theme).toBe('system');
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('theme 非法值忽略', () => {
    useSettingsStore.getState().applyMainSettingChange('theme', 'neon');
    useSettingsStore.getState().applyMainSettingChange('theme', 123);
    expect(useSettingsStore.getState().theme).toBe(DEFAULTS.theme);
  });

  it('language primitive：应用合法值且不回写', () => {
    useSettingsStore.getState().applyMainSettingChange('language', 'en');
    expect(useSettingsStore.getState().language).toBe('en');
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('settings-store.persist 失败重试', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: { settings: { set: setSpy } },
      writable: true,
      configurable: true,
    });
    setSpy.mockReset();
    setSpy.mockResolvedValue({ data: { ok: true } });
    useSettingsStore.setState({ theme: 'dark' });
  });

  it('写失败后 flushPendingSettings 会重试同键（内存与 SQLite 不永久分叉）', async () => {
    setSpy.mockRejectedValueOnce(new Error('db locked'));
    useSettingsStore.getState().setTheme('light');
    // 让首笔写 settle（失败已入 failedWrites）
    await flushPendingSettings();
    // flush 内已触发一次重试；再 flush 一次应成功落库且无待重试
    await flushPendingSettings();
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const themeWrites = calls.filter((c) => c[0]?.key === 'theme');
    expect(themeWrites.length).toBeGreaterThanOrEqual(2);
    expect(useSettingsStore.getState().theme).toBe('light');
  });

  it('写成功不进入重试账', async () => {
    useSettingsStore.getState().setTheme('dark');
    await flushPendingSettings();
    await flushPendingSettings();
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const themeWrites = calls.filter((c) => c[0]?.key === 'theme');
    expect(themeWrites.length).toBe(1);
  });
});

describe('settings-store.notification 域', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: { settings: { set: setSpy } },
      writable: true,
      configurable: true,
    });
    setSpy.mockReset();
    setSpy.mockResolvedValue({ data: { ok: true } });
  });

  it('updateNotification：部分字段合并 + 以 notification 键写穿透', () => {
    useSettingsStore.getState().updateNotification({ enabled: false });
    const state = useSettingsStore.getState().notification;
    expect(state).toEqual({ enabled: false, onTurnFinished: true, onTurnFailed: true });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'notification');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual({
      key: 'notification',
      value: { enabled: false, onTurnFinished: true, onTurnFailed: true },
    });
  });

  it('快照缺失 notification 键 → 回落默认（全开，向既有行为）', () => {
    useSettingsStore.setState({
      notification: { enabled: false, onTurnFinished: false, onTurnFailed: false },
    });
    applySettingsSnapshot({});
    expect(useSettingsStore.getState().notification).toEqual({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
    });
  });

  it('快照部分字段 → 与默认合并', () => {
    applySettingsSnapshot({ notification: { enabled: false } });
    expect(useSettingsStore.getState().notification).toEqual({
      enabled: false,
      onTurnFinished: true,
      onTurnFailed: true,
    });
  });

  it('applyMainChange(notification)：按域合并且不回写（导入广播回声防线，33 号 V8）', () => {
    useSettingsStore.getState().applyMainSettingChange('notification', {
      enabled: false,
      onTurnFailed: false,
    });
    expect(useSettingsStore.getState().notification).toEqual({
      enabled: false,
      onTurnFinished: true,
      onTurnFailed: false,
    });
    // 变更来源是主进程（导入已落库）：内存更新即真源，回写是回声——不得再写穿透
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    expect(calls.filter((c) => c[0]?.key === 'notification')).toHaveLength(0);
  });
});

describe('settings-store.proxy 域（34 号网络代理）', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: { settings: { set: setSpy } },
      writable: true,
      configurable: true,
    });
    setSpy.mockReset();
    setSpy.mockResolvedValue({ data: { ok: true } });
    useSettingsStore.setState({ proxy: { mode: 'system' } });
  });

  it('updateProxy：fixed 部分合并 + 以 proxy 键写穿透', () => {
    useSettingsStore.getState().updateProxy({ mode: 'fixed', url: 'http://127.0.0.1:7890' });
    expect(useSettingsStore.getState().proxy).toEqual({
      mode: 'fixed',
      url: 'http://127.0.0.1:7890',
    });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'proxy');
    expect(writes).toHaveLength(1);
  });

  it('模式从 fixed 切回 system → url/bypass 清除（非 fixed 域不携带代理数据）', () => {
    useSettingsStore.getState().updateProxy({
      mode: 'fixed',
      url: 'http://p:1',
      bypass: ['corp.example'],
    });
    useSettingsStore.getState().updateProxy({ mode: 'system' });
    expect(useSettingsStore.getState().proxy).toEqual({ mode: 'system' });
  });

  it('快照缺 proxy 键 → 回落 system（V1/V6 渲染半）', () => {
    useSettingsStore.getState().updateProxy({ mode: 'fixed', url: 'http://p:1' });
    applySettingsSnapshot({});
    expect(useSettingsStore.getState().proxy).toEqual({ mode: 'system' });
  });

  it('applyMainChange(proxy)：按域合并且不回写（导入广播回声防线，V8）', () => {
    useSettingsStore.getState().applyMainSettingChange('proxy', {
      mode: 'fixed',
      url: 'http://10.0.0.1:8080',
    });
    expect(useSettingsStore.getState().proxy).toEqual({
      mode: 'fixed',
      url: 'http://10.0.0.1:8080',
    });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    expect(calls.filter((c) => c[0]?.key === 'proxy')).toHaveLength(0);
  });
});

describe('settings-store.appearance 域（35 号界面缩放）', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      value: { settings: { set: setSpy } },
      writable: true,
      configurable: true,
    });
    setSpy.mockReset();
    setSpy.mockResolvedValue({ data: { ok: true } });
    useSettingsStore.setState({ appearance: { zoom: 1 } });
  });

  it('updateAppearance：部分合并 + 以 appearance 键写穿透', () => {
    useSettingsStore.getState().updateAppearance({ zoom: 1.25 });
    expect(useSettingsStore.getState().appearance).toEqual({ zoom: 1.25 });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    const writes = calls.filter((c) => c[0]?.key === 'appearance');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toEqual({ key: 'appearance', value: { zoom: 1.25 } });
  });

  it('V1 快照缺失 → 回落 1；V1 损坏值 → clampZoom 最近档位归一（CP2 fail-5）', () => {
    useSettingsStore.getState().updateAppearance({ zoom: 2 });
    applySettingsSnapshot({});
    expect(useSettingsStore.getState().appearance).toEqual({ zoom: 1 });

    applySettingsSnapshot({ appearance: { zoom: 0.93 } });
    expect(useSettingsStore.getState().appearance).toEqual({ zoom: 0.9 });

    applySettingsSnapshot({ appearance: { zoom: 'junk' } });
    expect(useSettingsStore.getState().appearance).toEqual({ zoom: 1 });
  });

  it('V6 导入回显：applyMainChange 通用分支按域合并且不回写', () => {
    useSettingsStore.getState().applyMainSettingChange('appearance', { zoom: 1.5 });
    expect(useSettingsStore.getState().appearance).toEqual({ zoom: 1.5 });
    const calls = setSpy.mock.calls as unknown as { key: string }[][];
    expect(calls.filter((c) => c[0]?.key === 'appearance')).toHaveLength(0);
  });
});
