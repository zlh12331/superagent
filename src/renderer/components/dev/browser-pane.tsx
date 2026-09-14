// src/renderer/components/dev/browser-pane.tsx
// 浏览器预览 pane（右面板「浏览器」tab，WebContentsView 进程外预览）
// ──────────────────────────────────────────────────────────────
// v1 用渲染层 iframe 加载外站，被主进程 defaultSession 统一注入的安全头三层
// 拦截（CSP 无 frame-src 回退 default-src 'self' + X-Frame-Options 注入到远端
// 响应本身 + 注入的 CSP 污染远端文档），生产环境加载不了任何真实网页。
// v2 重写（2026-09-12）：页面在主进程 WebContentsView（独立内存 session 分区）
// 加载（src/main/infra/browser/preview-service.ts），本组件只保留工具栏：
// - 占位区 div 由 use-browser-viewport 测量后推送主进程对齐视图位置
// - 地址/加载中/历史能力来自 browser:getState 初值 + browser:event:state 推送
// - 主框架加载失败走 browser:event:loadFailed → toast（占位区内的渲染层
//   UI 会被原生视图盖住，错误反馈必须放在占位区之外）
// 设置消费（设置 → 浏览器）：预设/缩放为挂载初值（工具栏内临时改动不写回），
// 严格沙箱经 browser:configure 生效（禁用预览页 JS，切换时重建视图）。
// ──────────────────────────────────────────────────────────────

import type { BrowserLoadFailedPayload, BrowserState } from '@code-agent/shared/renderer';
import { ArrowLeft, ArrowRight, Link2, MonitorSmartphone, RotateCw } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { DeviceBar } from './browser-device-bar';
import { useBrowserViewport } from './use-browser-viewport';

/** 设备预设类型（真源在 settings-store，浏览器 pane 与设置面板共用） */
type DevicePreset = BrowserDevicePreset;

/** 设备预设 → 默认宽高映射（对齐参考项目 DEVICE_DIMENSIONS） */
const DEVICE_DIMENSIONS: Record<DevicePreset, { width: number; height: number }> = {
  responsive: { width: 0, height: 0 },
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
};

/** 工具栏按钮基础样式 */
const TOOLBAR_BTN_CLASS =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30';

/** 规范化 URL：缺少协议时自动补 https:// */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 预览状态初值（主进程 getState 在视图创建前的返回与此一致） */
const INITIAL_STATE: BrowserState = {
  url: null,
  title: null,
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
};

/**
 * 浏览器预览 pane
 */
export function BrowserPane(): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  // 设置分组：预设/缩放是挂载初值（工具栏内临时改不写回），严格沙箱实时生效
  const browserSettings = useSettingsStore((s) => s.browser);
  // 预览状态（组件独享：getState 初值 + browser:event:state 推送，不入全局 store）
  const [state, setState] = useState<BrowserState>(INITIAL_STATE);
  // 主框架加载失败（经 browser:event:loadFailed 推送，toast 反馈）
  const [loadError, setLoadError] = useState<BrowserLoadFailedPayload | null>(null);
  // URL 输入框当前值（跟随页面导航更新）
  const [urlInput, setUrlInput] = useState('');
  // 设备工具栏可见性
  const [showDeviceBar, setShowDeviceBar] = useState(false);
  // 设备预设与宽高
  const [devicePreset, setDevicePreset] = useState<DevicePreset>(
    browserSettings.defaultDevicePreset,
  );
  const [deviceWidth, setDeviceWidth] = useState(
    DEVICE_DIMENSIONS[browserSettings.defaultDevicePreset].width,
  );
  const [deviceHeight, setDeviceHeight] = useState(
    DEVICE_DIMENSIONS[browserSettings.defaultDevicePreset].height,
  );
  const [deviceZoom, setDeviceZoom] = useState<BrowserZoom>(browserSettings.defaultZoom);
  // 占位区 ref（use-browser-viewport 测量后推送主进程）
  const hostRef = useRef<HTMLDivElement>(null);

  useBrowserViewport({
    hostRef,
    preset: devicePreset,
    deviceWidth,
    deviceHeight,
    zoom: deviceZoom,
    active: state.url !== null,
    strictSandbox: browserSettings.strictSandbox,
  });

  // 挂载：拉状态初值 + 订阅推送（组件独享状态，卸载即弃）
  // 竞态守卫：getState IPC 在途时事件可能先到——事件一旦到达，迟到的
  // getState 快照视为陈旧值丢弃（否则 UI 会被旧状态回退）
  const receivedEventRef = useRef(false);
  useEffect(() => {
    let active = true;
    void window.api.browser
      .getState()
      .then((res) => {
        if (active && !receivedEventRef.current) setState(unwrap(res));
      })
      .catch(() => {});
    const unsubscribeState = window.api.browser.subscribeState((payload) => {
      receivedEventRef.current = true;
      setState(payload);
      // 新一次加载开始时清除上一次的失败状态
      if (payload.isLoading) {
        setLoadError(null);
      }
    });
    const unsubscribeLoadFailed = window.api.browser.subscribeLoadFailed((payload) => {
      setLoadError(payload);
    });
    return () => {
      active = false;
      unsubscribeState();
      unsubscribeLoadFailed();
    };
  }, []);

  // 主框架加载失败 → toast（错误 UI 必须在占位区之外，否则被原生视图盖住）
  useEffect(() => {
    if (loadError === null) return;
    toast.error(t('panel.browserLoadFailed'), {
      description: `${loadError.errorCode}: ${loadError.errorDescription}`,
    });
  }, [loadError, t]);

  // 地址栏跟随页面导航（用户输入中仅在导航事件时被覆盖，与真实浏览器一致）
  useEffect(() => {
    if (state.url !== null) {
      setUrlInput(state.url);
    }
  }, [state.url]);

  /** 加载指定 URL（规范化补协议；结果状态经事件推送回流） */
  const navigateTo = (raw: string): void => {
    const normalized = normalizeUrl(raw);
    if (normalized === '') return;
    setUrlInput(normalized);
    void window.api.browser
      .navigate({ url: normalized })
      .then(unwrap)
      .catch((error: Error) => {
        toast.error(unwrapErrorMessage(error, getErrorMessage));
      });
  };

  /** 后退 */
  const goBack = (): void => {
    void window.api.browser
      .back()
      .then(unwrap)
      .catch(() => {});
  };

  /** 前进 */
  const goForward = (): void => {
    void window.api.browser
      .forward()
      .then(unwrap)
      .catch(() => {});
  };

  /** 刷新 */
  const reload = (): void => {
    void window.api.browser
      .reload()
      .then(unwrap)
      .catch(() => {});
  };

  /** 切换设备预设 */
  const handlePresetChange = (preset: DevicePreset): void => {
    setDevicePreset(preset);
    const dims = DEVICE_DIMENSIONS[preset];
    if (dims.width > 0) {
      setDeviceWidth(dims.width);
      setDeviceHeight(dims.height);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：导航 + 地址栏 + 设备按钮 */}
      <div className="border-border bg-muted/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          title={t('panel.browserBack')}
          aria-label={t('panel.browserBack')}
          onClick={goBack}
          disabled={!state.canGoBack}
          className={TOOLBAR_BTN_CLASS}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={t('panel.browserForward')}
          aria-label={t('panel.browserForward')}
          onClick={goForward}
          disabled={!state.canGoForward}
          className={TOOLBAR_BTN_CLASS}
        >
          <ArrowRight className="size-3.5" strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={t('panel.browserRefresh')}
          aria-label={t('panel.browserRefresh')}
          onClick={reload}
          disabled={state.url === null}
          className={TOOLBAR_BTN_CLASS}
        >
          <RotateCw className="size-3.5" strokeWidth={1.5} />
        </Button>

        {/* 地址栏 */}
        <div className="border-border bg-background flex h-6 min-w-0 flex-1 items-center rounded-full border px-2 transition-colors focus-within:border-primary">
          <Link2 className="text-muted-foreground mr-1.5 size-3 shrink-0" strokeWidth={1.5} />
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigateTo(urlInput);
            }}
            placeholder={t('panel.browserUrlPlaceholder')}
            spellCheck={false}
            aria-label={t('panel.browserUrlPlaceholder')}
            className="text-foreground h-full min-w-0 flex-1 border-none bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          />
        </div>

        {/* 设备工具栏开关 */}
        <Button
          variant="ghost"
          size="icon"
          title={t('panel.browserDeviceBar')}
          aria-label={t('panel.browserDeviceBar')}
          onClick={() => setShowDeviceBar((v) => !v)}
          className={cn(TOOLBAR_BTN_CLASS, showDeviceBar && 'bg-primary/10 text-accent-text')}
        >
          <MonitorSmartphone className="size-3.5" strokeWidth={1.5} />
        </Button>
      </div>

      {/* 设备工具栏（可切换显示；受控组件，状态在本 pane） */}
      {showDeviceBar && (
        <DeviceBar
          devicePreset={devicePreset}
          deviceWidth={deviceWidth}
          deviceHeight={deviceHeight}
          deviceZoom={deviceZoom}
          onPresetChange={handlePresetChange}
          onWidthChange={setDeviceWidth}
          onHeightChange={setDeviceHeight}
          onZoomChange={setDeviceZoom}
          onClose={() => setShowDeviceBar(false)}
        />
      )}

      {/* 加载进度条：位于占位区之外（占位区内的渲染层 UI 会被原生视图盖住） */}
      {state.isLoading && (
        <div className="bg-primary h-0.5 shrink-0 origin-left animate-[br-loading-bar_1.5s_ease-in-out_infinite]" />
      )}

      {/* 内容区：原生视图占位区 + 空状态（无 URL 时视图隐藏，渲染层可见） */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {state.url === null && !state.isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Link2 className="text-muted-foreground/30 size-10" strokeWidth={1.5} />
            <p className="text-muted-foreground text-xs">{t('panel.browserEmpty')}</p>
          </div>
        )}
        {state.isLoading && state.url === null && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner className="text-muted-foreground size-5" />
          </div>
        )}
        <div ref={hostRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
