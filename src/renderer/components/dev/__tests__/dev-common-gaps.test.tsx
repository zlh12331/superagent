// src/renderer/components/dev/__tests__/dev-common-gaps.test.tsx
// dev/common 域批次6 缺口补全：browser-pane 导航与设备预设 + UnifiedDiffView hunk 渲染
//
// 测试要点：
// 1. browser-pane（WebContentsView 重写版）：空状态/URL 规范化/Enter 导航/
//    状态事件驱动 UI（地址栏/导航按钮/加载条）/视口推送/严格沙箱 configure/
//    设备预设切换/宽高输入禁用
//    （jsdom 无原生视图：主进程侧交互全部经 window.api.browser fake 断言）
// 2. UnifiedDiffView：空 diff 提示/单 hunk 渲染/多 hunk/主题包装

import type { BrowserState } from '@code-agent/shared/renderer';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { applySettingsSnapshot } from '@/stores/persistent/settings-store';
import { UnifiedDiffView } from '../../common/UnifiedDiffView';
import { BrowserPane } from '../browser-pane';

const DIFF_SAMPLE = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3`;

const DIFF_TWO_HUNKS = `${DIFF_SAMPLE}
@@ -10,2 +11,2 @@
 old
+new`;

const EMPTY_STATE: BrowserState = {
  url: null,
  title: null,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

describe('dev/common 批次6 缺口补全', () => {
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

  describe('browser-pane', () => {
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
      await waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith({ url: 'https://example.com' }),
      );
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
  });

  describe('UnifiedDiffView', () => {
    it('空 diff：显示 noDiff 提示', () => {
      render(
        <ThemeProvider>
          <UnifiedDiffView diff="" />
        </ThemeProvider>,
      );
      expect(screen.getByText('无 diff 内容')).toBeDefined();
    });

    it('parseUnifiedDiff：样例解析为 1 个 hunk（内容行完整）', async () => {
      const { parseUnifiedDiff } = await import('@/lib/diff/unified-diff');
      const hunks = parseUnifiedDiff(DIFF_SAMPLE);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]?.oldLines.join('\n')).toContain('line1');
      expect(hunks[0]?.newLines.join('\n')).toContain('line2');
    });

    it('单 hunk diff：渲染 ReactDiffViewer（table 结构存在）', () => {
      render(
        <ThemeProvider>
          <UnifiedDiffView diff={DIFF_SAMPLE} />
        </ThemeProvider>,
      );
      // ReactDiffViewer 渲染 diff table（内容行由 parse 用例保证完整）
      expect(document.querySelector('table')).not.toBeNull();
    });

    it('多 hunk diff：渲染全部变更块（多个 table）', () => {
      render(
        <ThemeProvider>
          <UnifiedDiffView diff={DIFF_TWO_HUNKS} />
        </ThemeProvider>,
      );
      expect(document.querySelectorAll('table')).toHaveLength(2);
    });

    it('空 diff 与有效 diff 切换：useMemo 重算', () => {
      const { rerender } = render(
        <ThemeProvider>
          <UnifiedDiffView diff="" />
        </ThemeProvider>,
      );
      expect(screen.getByText('无 diff 内容')).toBeDefined();
      rerender(
        <ThemeProvider>
          <UnifiedDiffView diff={DIFF_SAMPLE} />
        </ThemeProvider>,
      );
      expect(document.querySelector('table')).not.toBeNull();
    });
  });
});

// ── browser-pane fake 基础设施（模块级变量，beforeEach 重置） ──

let stateSubs = new Set<(p: BrowserState) => void>();
let failSubs = new Set<(p: { errorCode: number; errorDescription: string; url: string }) => void>();
let currentState: BrowserState = { ...EMPTY_STATE };
let navigateMock: ReturnType<typeof vi.fn>;
let setViewportMock: ReturnType<typeof vi.fn>;
let configureMock: ReturnType<typeof vi.fn>;
