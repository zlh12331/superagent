// src/renderer/components/terminal/TerminalView.tsx
// 终端视图（xterm.js 单实例包装器，自 TerminalPanel 提取；对齐参考项目 TerminalView）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 创建 xterm Terminal 实例并挂载到容器
// - 订阅 IPC terminal:event:output（按 terminalId 过滤，直接 write）
// - 用户输入 onData → IPC terminal:input
// - ResizeObserver + FitAddon 自适应尺寸（防抖 100ms）→ IPC terminal:resize
// - 终端退出（alive=false）时显示「已结束」标识 + 禁止输入
//
// 设计（照搬参考项目 TerminalView）：
// - 每个终端一个组件实例，由 TerminalPanel 全部挂载、display:none 切换，
//   xterm 实例保持存活，切 Tab 无需重建、保留历史输出
// - 输出真源：直接订阅 IPC 事件（不走 store buffer）
// - 主题：从 CSS 令牌读取（--bg/--text 等），跟随全局明暗主题，
//   并通过监听 <html>.dark 类变更实时同步（避免在组件内硬编码色值）
// ──────────────────────────────────────────────────────────────

import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';
import { CircleSlash } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';

import { useTranslation } from '@/i18n/use-translation';
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
  // 选区色用专用令牌（0.25～0.30 保证可见性）；此前沿用 --border（透明度仅 0.12）选中几乎不可见
  const selection = readToken('--terminal-selection') || 'rgba(120,120,120,0.3)';
  // 亮色主题下白底终端中 ANSI brightWhite 文本会隐形：映射为可辨识中灰；暗色主题维持 xterm 默认
  const isDark = document.documentElement.classList.contains('dark');
  // 令牌缺失（jsdom/解析失败）时回退中性值，避免空色破坏 xterm 渲染
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
  // 本地化文案
  const { t } = useTranslation();
  // xterm 容器 div 引用（用于挂载 Terminal 实例）
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── xterm.js 实例生命周期管理 ────────────────────────────
  // 依赖 session.id 变化时重新初始化（切换终端或新建终端时触发）
  useEffect(() => {
    if (containerRef.current === null) return;

    const terminalId = session.id;
    const container = containerRef.current;

    // 创建 Terminal 实例（文学风主题：米色背景 + 衬线字体）
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Consolas", monospace',
      fontSize: 13,
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

    // 主题实时同步：监听 <html>.dark 类变更（由 ThemeProvider.applyTheme 驱动），
    // 类切换后重读 CSS 令牌更新 xterm 色板，无需重建终端实例
    const themeObserver = new MutationObserver(() => {
      if (term.options) term.options.theme = resolveTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // 从 store buffer 读取历史输出作为兜底（P3 修复：原始 ANSI 字符串原样恢复，
    // 不再切行拼接——此前切行破坏转义序列导致恢复输出损坏）
    // 仅用于组件卸载重挂时恢复可见内容，新输出由 IPC 直接消费
    const { buffers } = useTerminalStore.getState();
    const initialBuffer = buffers.get(terminalId);
    if (initialBuffer !== undefined && initialBuffer.length > 0) {
      term.write(initialBuffer);
    }

    // 订阅 IPC output 事件：按 terminalId 过滤，直接 write 到 xterm
    // 不走 store buffer，性能最优
    const unsubscribeOutput = window.api.terminal.subscribeOutputEvent((payload) => {
      if (payload.terminalId !== terminalId) return;
      term.write(payload.data);
    });

    // 订阅 IPC exit 事件：标记 alive=false（store 已通过 useTerminalBridge 处理）
    // 此处仅用于在终端退出时关闭输入响应（避免向已退出的 PTY 发送数据）
    let isExited = false;
    const unsubscribeExit = window.api.terminal.subscribeExitEvent((payload) => {
      if (payload.terminalId !== terminalId) return;
      isExited = true;
      // 在终端末尾追加退出提示（便于用户感知）
      term.write(`\r\n\x1b[2m${t('terminal.exited', { code: payload.exitCode })}\x1b[0m\r\n`);
    });

    // 用户输入回调：直接转发到 IPC（不经过 store）
    term.onData((data) => {
      if (isExited) return;
      void window.api.terminal.input({ terminalId, data });
    });

    // 自适应尺寸：ResizeObserver + 防抖
    // 容器尺寸变化时调用 fitAddon.fit 计算新 cols/rows，并同步到主进程 PTY
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit();
          const { cols, rows } = term;
          void window.api.terminal.resize({ terminalId, cols, rows });
        } catch (error) {
          // fit 在容器隐藏或尺寸为 0 时可能抛错，忽略
          // 此处不弹 toast（高频场景），仅静默吞掉避免控制台噪声
          void error;
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    // 清理：组件卸载或 session.id 变化时调用
    return () => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribeOutput();
      unsubscribeExit();
      term.dispose();
    };
  }, [session.id, t]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 已结束标识：仅终端退出后显示（alive=false），保留输出内容 */}
      {!session.alive && (
        <div className="border-border bg-muted/30 text-muted-foreground flex items-center gap-1.5 border-b px-2 py-0.5 text-2xs">
          <CircleSlash className="size-2.5" strokeWidth={1.5} />
          <span className="font-serif tracking-wide">{t('terminal.closed')}</span>
        </div>
      )}
      {/* xterm 挂载点：Terminal 实例会填充此容器 */}
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
