// src/renderer/components/dev/browser-pane.tsx
// 浏览器预览 pane（对齐原型 crpPaneBrowser + 参考项目 BrowserPane）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 地址栏 + 后退/前进/刷新导航（iframe 真实加载）
// - 设备预设切换（responsive/desktop/tablet/mobile，缩放预览）
// - 空状态：未加载 URL 时提示输入地址
//
// 数据源：纯前端 iframe（无后端依赖）；跨域页面仅展示页面本身，
// 无法注入内容（诚实边界：不做远程调试/CDP 注入）。
// ──────────────────────────────────────────────────────────────

import { ArrowLeft, ArrowRight, Link2, MonitorSmartphone, RotateCw, X } from 'lucide-react';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 设备预设类型（对齐参考项目 BrowserPane：含 laptop） */
type DevicePreset = 'responsive' | 'desktop' | 'laptop' | 'tablet' | 'mobile';

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
  'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30';

/** 规范化 URL：缺少协议时自动补 https:// */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * 浏览器预览 pane
 */
export function BrowserPane(): ReactElement {
  const { t } = useTranslation();
  // URL 输入框当前值
  const [urlInput, setUrlInput] = useState('');
  // 已加载的 URL（null = 未加载，显示空状态）
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  // 浏览历史栈与指针
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // 加载状态（iframe onLoad 结束）
  const [loading, setLoading] = useState(false);
  // 设备工具栏可见性
  const [showDeviceBar, setShowDeviceBar] = useState(false);
  // 设备预设与宽高
  const [devicePreset, setDevicePreset] = useState<DevicePreset>('responsive');
  const [deviceWidth, setDeviceWidth] = useState(0);
  const [deviceHeight, setDeviceHeight] = useState(0);
  const [deviceZoom, setDeviceZoom] = useState(100);
  // 刷新用的 timer 句柄（卸载时清理）
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  /** 加载指定 URL，更新历史栈 */
  const navigateTo = (raw: string): void => {
    const normalized = normalizeUrl(raw);
    if (normalized === '') return;
    setUrlInput(normalized);
    setLoadedUrl(normalized);
    setLoading(true);
    const newHistory = [...history.slice(0, historyIndex + 1), normalized];
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  /** iframe 加载完成：结束加载状态 */
  const handleIframeLoad = (): void => {
    setLoading(false);
  };

  /** 后退 */
  const goBack = (): void => {
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    if (target !== undefined) {
      setHistoryIndex(historyIndex - 1);
      setUrlInput(target);
      setLoadedUrl(target);
      setLoading(true);
    }
  };

  /** 前进 */
  const goForward = (): void => {
    if (historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    if (target !== undefined) {
      setHistoryIndex(historyIndex + 1);
      setUrlInput(target);
      setLoadedUrl(target);
      setLoading(true);
    }
  };

  /** 刷新：重新挂载 iframe（key 变化强制重载） */
  const refresh = (): void => {
    if (loadedUrl === null) return;
    setLoading(true);
    setLoadedUrl(null);
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      setLoadedUrl(urlInput);
      refreshTimerRef.current = null;
    }, 100);
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

  // iframe 容器样式：非 responsive 预设时应用固定宽高与缩放
  const iframeWrapperStyle: CSSProperties =
    devicePreset === 'responsive'
      ? {}
      : {
          width: deviceWidth,
          height: deviceHeight,
          transform: `scale(${deviceZoom / 100})`,
          transformOrigin: 'top left',
        };

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏：导航 + 地址栏 + 设备按钮 */}
      <div className="border-border bg-muted/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <button
          type="button"
          title={t('panel.browserBack')}
          aria-label={t('panel.browserBack')}
          onClick={goBack}
          disabled={historyIndex <= 0}
          className={TOOLBAR_BTN_CLASS}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          title={t('panel.browserForward')}
          aria-label={t('panel.browserForward')}
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          className={TOOLBAR_BTN_CLASS}
        >
          <ArrowRight className="size-3.5" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          title={t('panel.browserRefresh')}
          aria-label={t('panel.browserRefresh')}
          onClick={refresh}
          disabled={loadedUrl === null}
          className={TOOLBAR_BTN_CLASS}
        >
          <RotateCw className="size-3.5" strokeWidth={1.5} />
        </button>

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
        <button
          type="button"
          title={t('panel.browserDeviceBar')}
          aria-label={t('panel.browserDeviceBar')}
          onClick={() => setShowDeviceBar((v) => !v)}
          className={cn(TOOLBAR_BTN_CLASS, showDeviceBar && 'bg-primary/10 text-primary')}
        >
          <MonitorSmartphone className="size-3.5" strokeWidth={1.5} />
        </button>
      </div>

      {/* 设备工具栏（可切换显示） */}
      {showDeviceBar && (
        <div className="border-border bg-muted/30 flex h-7 shrink-0 items-center gap-1.5 border-b px-2">
          <select
            value={devicePreset}
            onChange={(e) => handlePresetChange(e.target.value as DevicePreset)}
            aria-label={t('panel.browserDevicePreset')}
            className="border-border bg-background text-muted-foreground h-[22px] shrink-0 cursor-pointer rounded border px-1.5 text-xs focus:border-primary"
          >
            <option value="responsive">{t('panel.browserDeviceResponsive')}</option>
            <option value="desktop">{t('panel.browserDeviceDesktop')}</option>
            <option value="laptop">{t('panel.browserDeviceLaptop')}</option>
            <option value="tablet">{t('panel.browserDeviceTablet')}</option>
            <option value="mobile">{t('panel.browserDeviceMobile')}</option>
          </select>
          <div className="flex shrink-0 items-center gap-0.5">
            <input
              type="number"
              value={deviceWidth}
              onChange={(e) => setDeviceWidth(Number(e.target.value))}
              min={200}
              max={3000}
              disabled={devicePreset === 'responsive'}
              aria-label={t('panel.browserDeviceWidth')}
              className="border-border bg-background text-muted-foreground h-[22px] w-[42px] rounded border text-center font-mono text-xs disabled:opacity-40"
            />
            <span className="text-muted-foreground px-0.5 font-mono text-xs">×</span>
            <input
              type="number"
              value={deviceHeight}
              onChange={(e) => setDeviceHeight(Number(e.target.value))}
              min={200}
              max={3000}
              disabled={devicePreset === 'responsive'}
              aria-label={t('panel.browserDeviceHeight')}
              className="border-border bg-background text-muted-foreground h-[22px] w-[42px] rounded border text-center font-mono text-xs disabled:opacity-40"
            />
          </div>
          <select
            value={deviceZoom}
            onChange={(e) => setDeviceZoom(Number(e.target.value))}
            aria-label={t('panel.browserZoom')}
            className="border-border bg-background text-muted-foreground h-[22px] shrink-0 cursor-pointer rounded border px-1 text-xs"
          >
            <option value={50}>50%</option>
            <option value={75}>75%</option>
            <option value={100}>100%</option>
            <option value={125}>125%</option>
            <option value={150}>150%</option>
            <option value={200}>200%</option>
          </select>
          <button
            type="button"
            title={t('panel.browserCloseDeviceBar')}
            aria-label={t('panel.browserCloseDeviceBar')}
            onClick={() => setShowDeviceBar(false)}
            className={cn(TOOLBAR_BTN_CLASS, 'ml-auto shrink-0')}
          >
            <X className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      )}

      {/* 内容区：加载进度条 + 空状态 / iframe 预览 */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {loading && (
          <div className="bg-primary absolute right-0 top-0 left-0 z-[2] h-0.5 origin-left animate-[br-loading-bar_1.5s_ease-in-out_infinite]" />
        )}
        {loadedUrl === null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Link2 className="text-muted-foreground/30 size-10" strokeWidth={1.5} />
            <p className="text-muted-foreground text-xs">{t('panel.browserEmpty')}</p>
          </div>
        )}
        {loadedUrl !== null && (
          <div className="absolute inset-0 overflow-auto" style={iframeWrapperStyle}>
            <iframe
              key={loadedUrl}
              src={loadedUrl}
              title={t('panel.browserPreview')}
              onLoad={handleIframeLoad}
              className="h-full w-full border-none bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}
      </div>
    </div>
  );
}
