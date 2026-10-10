import type {
  BrowserLoadFailedPayload,
  BrowserState,
  IpcResponse,
} from '@code-agent/shared/renderer';
import { ArrowLeft, ArrowRight, Link2, MonitorSmartphone, RotateCw } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { DEVICE_DIMENSIONS } from '@/lib/browser/presets';
import {
  type BrowserNavRes,
  browserBack,
  browserForward,
  browserNavigate,
  browserReload,
  getBrowserState,
  subscribeBrowserLoadFailed,
  subscribeBrowserState,
} from '@/lib/browser-actions';
import { hasIpcBridge, unwrap, unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { DeviceBar } from './browser-device-bar';
import { TOOLBAR_BTN_CLASS } from './browser-toolbar';
import { normalizeUrl } from './browser-url';
import { useBrowserViewport } from './use-browser-viewport';

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
  const browserSettings = useSettingsStore((s) => s.browser);
  const [state, setState] = useState<BrowserState>(INITIAL_STATE);
  const [loadError, setLoadError] = useState<BrowserLoadFailedPayload | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [showDeviceBar, setShowDeviceBar] = useState(false);
  const [devicePreset, setDevicePreset] = useState<BrowserDevicePreset>(
    browserSettings.defaultDevicePreset,
  );
  const [deviceWidth, setDeviceWidth] = useState(
    DEVICE_DIMENSIONS[browserSettings.defaultDevicePreset].width,
  );
  const [deviceHeight, setDeviceHeight] = useState(
    DEVICE_DIMENSIONS[browserSettings.defaultDevicePreset].height,
  );
  const [deviceZoom, setDeviceZoom] = useState<BrowserZoom>(browserSettings.defaultZoom);
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

  const receivedEventRef = useRef(false);
  useEffect(() => {
    if (!hasIpcBridge()) return;
    let active = true;
    void getBrowserState()
      .then((snap) => {
        if (active && !receivedEventRef.current) setState(snap);
      })
      .catch(() => {});
    const unsubscribeState = subscribeBrowserState((payload) => {
      receivedEventRef.current = true;
      setState(payload);
      if (payload.isLoading) {
        setLoadError(null);
      }
    });
    const unsubscribeLoadFailed = subscribeBrowserLoadFailed((payload) => {
      setLoadError(payload);
    });
    return () => {
      active = false;
      unsubscribeState();
      unsubscribeLoadFailed();
    };
  }, []);

  useEffect(() => {
    if (loadError === null) return;
    toast.error(t('panel.browserLoadFailed'), {
      description: `${loadError.errorCode}: ${loadError.errorDescription}`,
    });
  }, [loadError, t]);

  useEffect(() => {
    if (state.url !== null) {
      setUrlInput(state.url);
    }
  }, [state.url]);

  /**
   * 导航类动作的统一收口（后退/前进/刷新）
   *
   * 此前三处各写一份 `.then(unwrap).catch(() => {})`：既重复，又把失败完全
   * 静默——与 navigateTo 的「失败必提示」不一致。主进程这三个动作是幂等
   * no-op（无视图也返回 ok:true），故不会产生提示噪音。
   */
  const runNavigation = (pending: Promise<IpcResponse<BrowserNavRes>>): void => {
    void pending.then(unwrap).catch((error: Error) => {
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    });
  };

  /** 加载指定 URL（规范化补协议；结果状态经事件推送回流） */
  const navigateTo = (raw: string): void => {
    const normalized = normalizeUrl(raw);
    if (normalized === '') return;
    setUrlInput(normalized);
    if (!hasIpcBridge()) return;
    void browserNavigate(normalized).catch((error: Error) => {
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    });
  };

  /** 切换设备预设（responsive 用 0 表示跟随宿主，不覆盖宽高输入） */
  const handlePresetChange = (preset: BrowserDevicePreset): void => {
    setDevicePreset(preset);
    const dims = DEVICE_DIMENSIONS[preset];
    if (dims.width > 0) {
      setDeviceWidth(dims.width);
      setDeviceHeight(dims.height);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border bg-muted/30 flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          title={t('panel.browserBack')}
          aria-label={t('panel.browserBack')}
          onClick={() => {
            if (hasIpcBridge()) runNavigation(browserBack());
          }}
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
          onClick={() => {
            if (hasIpcBridge()) runNavigation(browserForward());
          }}
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
          onClick={() => {
            if (hasIpcBridge()) runNavigation(browserReload());
          }}
          disabled={state.url === null}
          className={TOOLBAR_BTN_CLASS}
        >
          <RotateCw className="size-3.5" strokeWidth={1.5} />
        </Button>

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

      {state.isLoading && (
        <div className="bg-primary h-0.5 shrink-0 animate-[browser-loading-bar_1.5s_ease-in-out_infinite]">
          <span className="sr-only" role="progressbar" aria-label={t('panel.browserLoading')} />
        </div>
      )}

      <div className="bg-background relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {state.url === null && !state.isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Link2
              className="text-muted-foreground/30 size-10"
              strokeWidth={1.5}
              aria-hidden="true"
            />
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
