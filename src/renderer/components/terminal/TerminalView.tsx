import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import { CircleSlash } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge } from '@/lib/ipc';
import {
  resizeTerminal,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  writeTerminalInput,
} from '@/lib/terminal-actions';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import type { TerminalMeta } from '@/stores/transient/terminal-store';
import { useTerminalStore } from '@/stores/transient/terminal-store';

/** ResizeObserver 防抖时间（ms），避免快速拖动产生多次 IPC resize */
const RESIZE_DEBOUNCE_MS = 100;

/**
 * 从当前生效的 CSS 令牌解析 xterm 色板。
 *
 * 与 tokens.css 的明暗色板联动（--bg/--text/--text-secondary/--border），
 * 避免在组件内硬编码颜色，暗色/亮色随全局主题自动同步。
 *
 * @remarks 读取前调用方需确保 <html> 的 .dark 类已反映目标主题（见 ThemeProvider.applyTheme）；
 * @returns xterm ITheme 色板对象
 */
function resolveTerminalTheme(): ITheme {
  const readToken = (name: string): string => {
    if (typeof window === 'undefined' || !window.getComputedStyle) return '';
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  };
  const background = readToken('--bg');
  const foreground = readToken('--text');
  const cursor = readToken('--text-secondary');
  const selection = readToken('--terminal-selection') || 'rgba(120,120,120,0.3)';
  const isDark = document.documentElement.classList.contains('dark');
  return {
    background: background || '#1E1E1E',
    foreground: foreground || '#CCCCCC',
    cursor: cursor || '#5C5C5C',
    cursorAccent: background || '#1E1E1E',
    selectionBackground: selection,
    ...(isDark ? {} : { brightWhite: '#555555' }),
  };
}

/** TerminalView props */
interface TerminalViewProps {
  /** 终端元数据（id 变化时重新初始化 xterm 实例） */
  readonly session: TerminalMeta;
}

/**
 * 终端视图组件。
 *
 * 生命周期：session.id 变化时销毁旧实例并重建（切换终端 / 新建终端时触发）。
 */
export function TerminalView({ session }: TerminalViewProps): ReactElement {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (containerRef.current === null) return;
    if (!hasIpcBridge()) return;

    const terminalId = session.id;
    const container = containerRef.current;

    const term = new Terminal({
      fontFamily:
        '"Cascadia Code", "JetBrains Mono", "Consolas", "Noto Sans SC", "Microsoft YaHei", monospace',
      fontSize: useSettingsStore.getState().terminal.fontSize,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: resolveTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const themeObserver = new MutationObserver(() => {
      if (term.options) term.options.theme = resolveTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const { buffers } = useTerminalStore.getState();
    const initialBuffer = buffers.get(terminalId);
    if (initialBuffer !== undefined && initialBuffer.length > 0) {
      term.write(initialBuffer);
    }

    const unsubscribeOutput = subscribeTerminalOutput((payload) => {
      if (payload.terminalId !== terminalId) return;
      term.write(payload.data);
    });

    let isExited = false;
    const unsubscribeExit = subscribeTerminalExit((payload) => {
      if (payload.terminalId !== terminalId) return;
      isExited = true;
      term.write(`\r\n\x1b[2m${t('terminal.exited', { code: payload.exitCode })}\x1b[0m\r\n`);
    });

    term.onData((data) => {
      if (isExited) return;
      writeTerminalInput(terminalId, data);
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit();
          const { cols, rows } = term;
          resizeTerminal(terminalId, cols, rows);
        } catch (error) {
          void error;
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    let lastFontSize = useSettingsStore.getState().terminal.fontSize;
    const unsubscribeFontSize = useSettingsStore.subscribe((state) => {
      const next = state.terminal.fontSize;
      if (next === lastFontSize) return;
      lastFontSize = next;
      term.options.fontSize = next;
      try {
        fitAddon.fit();
      } catch {}
    });

    return () => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribeFontSize();
      unsubscribeOutput();
      unsubscribeExit();
      term.dispose();
    };
  }, [session.id, t]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {!session.alive && (
        <div className="border-border bg-muted/30 text-muted-foreground flex items-center gap-1.5 border-b px-2 py-0.5 text-2xs">
          <CircleSlash className="size-2.5" strokeWidth={1.5} />
          <span className="font-serif tracking-wide">{t('terminal.closed')}</span>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
