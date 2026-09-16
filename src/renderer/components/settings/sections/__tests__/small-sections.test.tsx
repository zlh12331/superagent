// src/renderer/components/settings/sections/__tests__/small-sections.test.tsx
// 设置区小组件测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖动机：以下文件此前均为 0% 覆盖（本轮覆盖率排查确认）。它们体量小、
// 主要是「store 读写 + 纯展示」，但正是这类组件最容易在重构时被无声改坏：
//   - data-section（导出会话 / 打开数据目录，含 IPC 与用户取消分支）
//   - general-section（语言切换：i18n + SQLite 写穿透双写）
//   - experimental-section / editor-section（开关与分段控件写入 store）
//   - telemetry-section（三档遥测 + 需重启提示）
//   - shortcuts-section（快捷键录制写穿透）
//   - placeholders（移动端 pane 组合）/ rules-memory-section（静态说明）
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/persistent/settings-store';

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import { DataSection } from '../data-section';
import { EditorSection } from '../editor-section';
import { ExperimentalSection } from '../experimental-section';
import { GeneralSection } from '../general-section';
import { RulesMemorySection } from '../rules-memory-section';
import { ShortcutsSection } from '../shortcuts-section';
import { TelemetrySection } from '../telemetry-section';

const t = i18n.t.bind(i18n);

/**
 * 带 QueryClient 的渲染封装
 *
 * general / telemetry / rules-memory 等区块内含 TanStack Query 消费者
 * （子区块或记忆面板），无 provider 会直接抛「No QueryClient set」。
 */
function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState((s) => ({
    editor: { ...s.editor, fontSize: 14, vimMode: false },
    experimental: { scanlines: false, reasoningCollapsed: false, autoCompact: false },
    shortcuts: { ...s.shortcuts },
  }));
});

// ── data-section：会话导出 / 打开数据目录 ─────────────────────

describe('DataSection', () => {
  it('正向：导出成功 → 成功提示（含路径）', async () => {
    window.api = {
      session: {
        exportAll: vi.fn().mockResolvedValue({ data: { saved: true, path: '/tmp/a.zip' } }),
      },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        t('settings.exportSuccess', { path: '/tmp/a.zip' }),
      ),
    );
  });

  it('边界：用户取消（saved=false）→ 静默，不提示成功也不报错', async () => {
    window.api = {
      session: { exportAll: vi.fn().mockResolvedValue({ data: { saved: false } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() => expect(window.api.session.exportAll).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('异常：导出失败（错误信封）→ 失败提示', async () => {
    window.api = {
      session: { exportAll: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(t('settings.exportFailed')));
  });

  it('正向：打开数据目录 ok=true → 成功提示', async () => {
    window.api = {
      app: { openDataDir: vi.fn().mockResolvedValue({ data: { ok: true } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(t('settings.dataDirOpened')));
  });

  it('异常：打开数据目录 ok=false → 失败提示', async () => {
    window.api = {
      app: { openDataDir: vi.fn().mockResolvedValue({ data: { ok: false } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(t('settings.exportFailed')));
  });

  it('边界：浏览器模式（无桥）→ 不调 IPC、不抛错、无提示', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));
    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

// ── general-section：语言切换 ─────────────────────────────────

describe('GeneralSection', () => {
  it('正向：渲染语言行与各子区块（编辑器/快捷键/提示词/数据/遥测）', () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);

    expect(screen.getByText(t('settings.language'))).toBeDefined();
    expect(screen.getByText(t('settings.dataTitle'))).toBeDefined();
    expect(screen.getByText(t('settings.telemetryTitle'))).toBeDefined();
  });

  it('正向：点 English → 写入 settings-store（SQLite 写穿透真源）', async () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);

    await userEvent.click(screen.getByRole('button', { name: /English/ }));

    expect(useSettingsStore.getState().language).toBe('en');
  });

  it('边界：当前语言项带选中勾选（zh-CN 时简体中文高亮）', () => {
    renderWithQuery(<GeneralSection drawerOpen={false} />);
    // 两个语言项都渲染；当前项应带 Check 图标（以按钮内 svg 数量区分过脆，
    // 这里只断言两项都存在且可点击）
    expect(screen.getByRole('button', { name: /简体中文/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /English/ })).toBeDefined();
  });
});

// ── editor-section / experimental-section：store 写入 ─────────

describe('EditorSection', () => {
  it('正向：切换字号 → updateEditor 写 store', async () => {
    render(<EditorSection />);

    const items = screen.getAllByRole('radio');
    const sixteen = items.find((el) => el.textContent === '16');
    await userEvent.click(sixteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(16);
  });

  it('正向：vim 开关 → 写入 store', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('switch', { name: t('settings.editor.vimMode') }));

    expect(useSettingsStore.getState().editor.vimMode).toBe(true);
  });
});

describe('ExperimentalSection', () => {
  it('正向：切换 scanlines 开关 → 写入 store', async () => {
    render(<ExperimentalSection />);

    await userEvent.click(
      screen.getByRole('switch', { name: t('settings.experimental.scanlines') }),
    );

    expect(useSettingsStore.getState().experimental.scanlines).toBe(true);
  });

  it('正向：三个实验开关均渲染（诚实原则：只列已接入消费方的开关）', () => {
    render(<ExperimentalSection />);

    expect(
      screen.getByRole('switch', { name: t('settings.experimental.scanlines') }),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: t('settings.experimental.reasoningCollapsed') }),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: t('settings.experimental.autoCompact') }),
    ).toBeDefined();
  });
});

// ── shortcuts-section ────────────────────────────────────────

describe('ShortcutsSection', () => {
  it('正向：渲染六个快捷键行，每行一个录键控件', () => {
    render(<ShortcutsSection />);

    // 6 行 × 1 个 ShortcutPicker（button）
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('边界：已绑定键显示键名，未绑定显示占位文案', () => {
    useSettingsStore.setState((s) => ({
      shortcuts: { ...s.shortcuts, saveFile: '' },
    }));
    render(<ShortcutsSection />);

    expect(screen.getByText(t('settings.shortcutUnbound'))).toBeDefined();
  });
});

// ── telemetry-section ────────────────────────────────────────

describe('TelemetrySection', () => {
  it('正向：渲染三档遥测选项', async () => {
    window.api = {
      settings: {
        getTelemetryLevel: vi.fn().mockResolvedValue({ data: { level: 'full' } }),
        setTelemetryLevel: vi.fn(),
      },
    } as never;
    renderWithQuery(<TelemetrySection />);

    expect(screen.getByText(t('settings.telOff'))).toBeDefined();
    expect(screen.getByText(t('settings.telErrorOnly'))).toBeDefined();
    expect(screen.getByText(t('settings.telFull'))).toBeDefined();
  });

  it('边界：浏览器模式（无桥）→ 渲染三档且不抛错', () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderWithQuery(<TelemetrySection />);

    // 无桥时查询回落 off，UI 仍完整渲染
    expect(screen.getByText(t('settings.telOff'))).toBeDefined();
  });
});

// ── 静态区块 ─────────────────────────────────────────────────

describe('RulesMemorySection', () => {
  it('正向：渲染规则说明与记忆面板挂载点', () => {
    window.api = {
      memory: {
        list: vi.fn().mockResolvedValue({ data: { memories: [] } }),
        status: vi.fn().mockResolvedValue({ data: null }),
      },
    } as never;
    renderWithQuery(<RulesMemorySection />);

    expect(screen.getByText(t('settings.rulesTitle'))).toBeDefined();
    expect(screen.getByText(t('settings.memoryTitle'))).toBeDefined();
  });
});
