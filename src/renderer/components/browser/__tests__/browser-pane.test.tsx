// src/renderer/components/browser/__tests__/browser-pane.test.tsx
// 浏览器预览 pane 测试（WebContentsView 进程外预览的渲染层侧）
// ──────────────────────────────────────────────────────────────
// 覆盖：空状态 / URL 规范化 / Enter 导航（非 Enter 不导航）/ 状态事件驱动 UI
// （地址栏、导航按钮、加载条、首载 spinner）/ 导航动作 IPC 与失败提示 /
// 视口推送（遮挡让位、deps 变化不产生多余「先隐后显」）/ 严格沙箱 configure /
// 设备预设切换与宽高输入禁用。
// jsdom 无原生视图：主进程侧交互全部经 window.api.browser fake 断言。
// ──────────────────────────────────────────────────────────────

import type { BrowserState } from '@code-agent/shared/renderer';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySettingsSnapshot } from '@/stores/persistent/settings-store';
import { useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { BrowserPane } from '../browser-pane';

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

const EMPTY_STATE: BrowserState = {
  url: null,
  title: null,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

describe('BrowserPane', () => {
  beforeEach(() => {
    localStorage.clear();
    // 设置全量重置为默认（browser 分组由各用例注入初值，避免用例间串味）
    applySettingsSnapshot({});
    // fake window.api.browser：jsdom 无主进程原生视图，主进程交互全部经 fake 断言
    stateSubs = new Set();
    failSubs = new Set();
    currentState = { ...EMPTY_STATE };
    navigateMock = vi.fn(async () => ({ data: { ok: true } }));
    setViewportMock = vi.fn(async () => ({ data: { ok: true } }));
    configureMock = vi.fn(async () => ({ data: { ok: true } }));
    window.api.browser = {
      navigate: navigateMock,
      back: vi.fn(async () => ({ data: { ok: true } })),
      forward: vi.fn(async () => ({ data: { ok: true } })),
      reload: vi.fn(async () => ({ data: { ok: true } })),
      setViewport: setViewportMock,
      configure: configureMock,
      getState: vi.fn(async () => ({ data: currentState })),
      subscribeState: vi.fn((cb: (p: BrowserState) => void) => {
        stateSubs.add(cb);
        return () => {
          stateSubs.delete(cb);
        };
      }),
      subscribeLoadFailed: vi.fn(
        (cb: (p: { errorCode: number; errorDescription: string; url: string }) => void) => {
          failSubs.add(cb);
          return () => {
            failSubs.delete(cb);
          };
        },
      ),
    } as never;
  });

  it('空状态：未加载 URL 显示提示', () => {
    render(<BrowserPane />);
    expect(screen.getByText(/输入地址开始浏览/)).toBeDefined();
  });

  it('地址栏 Enter：规范化 URL（自动补 https://）后交给主进程', async () => {
    render(<BrowserPane />);
    fireEvent.change(screen.getByLabelText('输入网址，回车打开…'), {
      target: { value: 'example.com' },
    });
    fireEvent.keyDown(screen.getByLabelText('输入网址，回车打开…'), { key: 'Enter' });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ url: 'https://example.com' }));
  });

  it('已带协议 URL：原样传递', async () => {
    render(<BrowserPane />);
    const input = screen.getByLabelText('输入网址，回车打开…');
    fireEvent.change(input, { target: { value: 'http://localhost:3000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ url: 'http://localhost:3000' }),
    );
  });

  it('空输入 Enter：不导航', () => {
    render(<BrowserPane />);
    fireEvent.keyDown(screen.getByLabelText('输入网址，回车打开…'), { key: 'Enter' });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('地址栏：非 Enter 按键不导航', () => {
    render(<BrowserPane />);
    const input = screen.getByLabelText('输入网址，回车打开…');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('首次加载中（已开始加载但尚无 URL）：空态让位给居中 spinner', async () => {
    render(<BrowserPane />);
    expect(screen.getByText(/输入地址开始浏览/)).toBeDefined();
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: null, isLoading: true });
      }
    });
    expect(screen.queryByText(/输入地址开始浏览/)).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('初始状态：后退/前进按钮禁用（canGoBack/canGoForward 来自状态推送）', () => {
    render(<BrowserPane />);
    expect(screen.getByLabelText('后退')).toBeDisabled();
    expect(screen.getByLabelText('前进')).toBeDisabled();
  });

  it('状态推送：地址栏跟随导航 + 启用后退 + 显示加载条', async () => {
    render(<BrowserPane />);
    await act(async () => {
      for (const cb of stateSubs) {
        cb({
          url: 'https://a.com/',
          title: 'A',
          isLoading: true,
          canGoBack: true,
          canGoForward: false,
        });
      }
    });
    expect((screen.getByLabelText('输入网址，回车打开…') as HTMLInputElement).value).toBe(
      'https://a.com/',
    );
    expect(screen.getByLabelText('后退')).toBeEnabled();
    expect(screen.getByLabelText('前进')).toBeDisabled();
    // 加载条位于占位区之外（原生视图会盖住占位区内的渲染层 UI）
    expect(document.querySelector('[class*="br-loading-bar"]')).not.toBeNull();
  });

  it('状态推送：isLoading=false 清除加载条', async () => {
    render(<BrowserPane />);
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: 'https://a.com/', isLoading: true, canGoBack: true });
      }
    });
    expect(document.querySelector('[class*="br-loading-bar"]')).not.toBeNull();
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: 'https://a.com/', isLoading: false, canGoBack: true });
      }
    });
    expect(document.querySelector('[class*="br-loading-bar"]')).toBeNull();
  });

  it('加载失败推送：订阅链路畅通（新一次加载清除失败状态，不阻塞后续渲染）', async () => {
    render(<BrowserPane />);
    await act(async () => {
      for (const cb of failSubs) {
        cb({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', url: 'https://x.com' });
      }
    });
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: 'https://x.com/', isLoading: true });
      }
    });
    // 不抛错 + 加载条已出现（错误经 toast 反馈，UI 可继续交互）
    expect(document.querySelector('[class*="br-loading-bar"]')).not.toBeNull();
  });

  it('视口同步：挂载即推送占位区（jsdom 无布局 → rect null 隐藏）', async () => {
    const { unmount } = render(<BrowserPane />);
    await waitFor(() => expect(setViewportMock).toHaveBeenCalled());
    const first = setViewportMock.mock.calls[0]?.[0] as { rect: unknown; visible: boolean };
    expect(first.rect).toBeNull();
    expect(first.visible).toBe(false);
    // 卸载（关闭浏览器 tab）→ 再推送一次隐藏（主进程侧页面保活）
    const calls = setViewportMock.mock.calls.length;
    unmount();
    expect(setViewportMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('视口同步：deps 变化不得产生多余的「先隐后显」（隐藏只在卸载时发生）', async () => {
    const hostRect = { x: 0, y: 0, width: 400, height: 600 } as unknown as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect);
    try {
      const { unmount } = render(<BrowserPane />);
      await act(async () => {
        for (const cb of stateSubs) {
          cb({ ...EMPTY_STATE, url: 'https://a.com/' });
        }
      });
      // 打开设备工具栏并切换缩放 → deps 变化一次
      fireEvent.click(screen.getByLabelText('设备工具栏'));
      const before = setViewportMock.mock.calls.length;
      fireEvent.change(screen.getByLabelText('缩放'), { target: { value: '150' } });
      const after = setViewportMock.mock.calls.slice(before);
      // 只应有一条新推送（新 zoomFactor），不得先插一条 visible=false
      expect(after).toHaveLength(1);
      const pushed = lastViewport();
      expect(pushed.visible).toBe(true);
      expect(pushed.zoomFactor).toBe(1.5);
      expect(pushed.rect).toMatchObject({ width: 400, height: 600 });

      // 卸载才隐藏
      unmount();
      const last = lastViewport();
      expect(last.visible).toBe(false);
      expect(last.rect).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('视口同步：未加载 URL 时 active=false（不创建/显示视图）', async () => {
    render(<BrowserPane />);
    await waitFor(() => expect(setViewportMock).toHaveBeenCalled());
    for (const call of setViewportMock.mock.calls) {
      expect((call[0] as { visible: boolean }).visible).toBe(false);
    }
  });

  it('设备工具栏：开关切换', () => {
    render(<BrowserPane />);
    expect(screen.queryByLabelText('设备预设')).toBeNull();
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    expect(screen.getByLabelText('设备预设')).toBeDefined();
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    expect(screen.queryByLabelText('设备预设')).toBeNull();
  });

  it('设备预设切换：desktop 应用 1920×1080 宽高', () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    fireEvent.change(screen.getByLabelText('设备预设'), { target: { value: 'desktop' } });
    expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('1920');
    expect((screen.getByLabelText('高度') as HTMLInputElement).value).toBe('1080');
  });

  it('responsive 预设：宽高输入禁用', () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    expect(screen.getByLabelText('宽度')).toBeDisabled();
    expect(screen.getByLabelText('高度')).toBeDisabled();
  });

  it('responsive 预设：不覆盖宽高（保留上一具体预设的尺寸，不置 0）', () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    fireEvent.change(screen.getByLabelText('设备预设'), { target: { value: 'mobile' } });
    expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('375');
    // 跟随宿主语义：尺寸保留，否则矩形宽高为 0 会被 IPC schema 拒绝
    fireEvent.change(screen.getByLabelText('设备预设'), { target: { value: 'responsive' } });
    expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('375');
    expect((screen.getByLabelText('高度') as HTMLInputElement).value).toBe('667');
  });

  it('设置消费：默认预设与缩放作为 pane 初值', () => {
    applySettingsSnapshot({
      browser: { defaultDevicePreset: 'mobile', defaultZoom: 75 },
    });
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    expect((screen.getByLabelText('设备预设') as HTMLSelectElement).value).toBe('mobile');
    expect((screen.getByLabelText('宽度') as HTMLInputElement).value).toBe('375');
    expect((screen.getByLabelText('高度') as HTMLInputElement).value).toBe('667');
    expect((screen.getByLabelText('缩放') as HTMLSelectElement).value).toBe('75');
  });

  it('设置消费：严格沙箱开启 → 挂载即通知主进程 configure', async () => {
    applySettingsSnapshot({ browser: { strictSandbox: true } });
    render(<BrowserPane />);
    await waitFor(() => expect(configureMock).toHaveBeenCalledWith({ strictSandbox: true }));
  });

  it('默认策略：严格沙箱关闭 → configure(false) 幂等通知', async () => {
    render(<BrowserPane />);
    await waitFor(() => expect(configureMock).toHaveBeenCalledWith({ strictSandbox: false }));
  });

  it('导航动作：后退/前进/刷新分别调用对应 IPC（此前回调零覆盖）', async () => {
    render(<BrowserPane />);
    // 历史能力来自状态推送；刷新要求已加载 URL
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: 'https://a.com/', canGoBack: true, canGoForward: true });
      }
    });
    fireEvent.click(screen.getByLabelText('后退'));
    fireEvent.click(screen.getByLabelText('前进'));
    fireEvent.click(screen.getByLabelText('刷新'));
    await waitFor(() => {
      expect(window.api.browser.back).toHaveBeenCalledTimes(1);
      expect(window.api.browser.forward).toHaveBeenCalledTimes(1);
      expect(window.api.browser.reload).toHaveBeenCalledTimes(1);
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('导航动作：禁用态（无历史 / 未加载）点击不触发 IPC', () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('后退'));
    fireEvent.click(screen.getByLabelText('前进'));
    fireEvent.click(screen.getByLabelText('刷新'));
    expect(window.api.browser.back).not.toHaveBeenCalled();
    expect(window.api.browser.forward).not.toHaveBeenCalled();
    expect(window.api.browser.reload).not.toHaveBeenCalled();
  });

  it('导航动作失败：统一提示错误（不再被静默吞掉）', async () => {
    vi.mocked(window.api.browser.reload).mockResolvedValue({
      error: { code: 'BROWSER_RELOAD_FAILED', message: 'boom' },
    } as never);
    render(<BrowserPane />);
    await act(async () => {
      for (const cb of stateSubs) {
        cb({ ...EMPTY_STATE, url: 'https://a.com/' });
      }
    });
    fireEvent.click(screen.getByLabelText('刷新'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });

  it('地址导航失败：提示错误（navigateTo 的失败分支）', async () => {
    navigateMock.mockResolvedValue({
      error: { code: 'BROWSER_NAVIGATE_FAILED', message: 'blocked' },
    });
    render(<BrowserPane />);
    const input = screen.getByLabelText('输入网址，回车打开…');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });

  it('设备工具栏：点击关闭按钮后隐藏（受控状态回写本 pane）', () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByLabelText('设备工具栏'));
    expect(screen.getByLabelText('设备预设')).toBeDefined();
    fireEvent.click(screen.getByLabelText('关闭设备工具栏'));
    expect(screen.queryByLabelText('设备预设')).toBeNull();
  });

  it('视口同步：占位区有尺寸且已加载 → 可见；模态/确认弹窗打开 → 原生视图让位', async () => {
    const hostRect = {
      x: 800,
      y: 52,
      width: 400,
      height: 600,
    } as unknown as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(hostRect);
    try {
      render(<BrowserPane />);
      await act(async () => {
        for (const cb of stateSubs) {
          cb({ ...EMPTY_STATE, url: 'https://a.com/' });
        }
      });
      const shown = lastViewport();
      expect(shown.visible).toBe(true);
      expect(shown.rect).toMatchObject({ width: 400, height: 600 });

      // 遮挡源 1：全局模态（设置 / 命令面板 / 快捷键帮助）
      await act(async () => {
        useUiStore.setState({ settingsOpen: true });
      });
      expect(lastViewport().visible).toBe(false);

      // 遮挡源 2：命令式确认弹窗（overlayOpen 为 false 时走 confirmOpen 分支）
      useUiStore.setState({ settingsOpen: false });
      await act(async () => {
        useConfirmDialogStore.setState({
          currentRequest: {
            kind: 'confirm',
            confirmOptions: { title: 't', message: 'm' },
            resolver: () => {},
          },
        });
      });
      expect(lastViewport().visible).toBe(false);
    } finally {
      spy.mockRestore();
      useUiStore.setState({ settingsOpen: false });
      useConfirmDialogStore.setState({ currentRequest: null, queue: [] });
    }
  });
});

// ── browser-pane fake 基础设施（模块级变量，beforeEach 重置） ──

let stateSubs = new Set<(p: BrowserState) => void>();
let failSubs = new Set<(p: { errorCode: number; errorDescription: string; url: string }) => void>();
let currentState: BrowserState = { ...EMPTY_STATE };
let navigateMock: ReturnType<typeof vi.fn>;
let setViewportMock: ReturnType<typeof vi.fn>;
let configureMock: ReturnType<typeof vi.fn>;

/** 最近一次 setViewport 推送负载（无调用时返回隐藏态空值，避免可选链断言的空值隐患） */
function lastViewport(): {
  rect: { width: number; height: number } | null;
  visible: boolean;
  zoomFactor: number;
} {
  const calls = setViewportMock.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) {
    return { rect: null, visible: false, zoomFactor: 1 };
  }
  return last[0] as {
    rect: { width: number; height: number } | null;
    visible: boolean;
    zoomFactor: number;
  };
}
