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
// - 主题：文学风米黄纸张底色（与 paper-texture 对齐）
// ──────────────────────────────────────────────────────────────

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { CircleSlash } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import type { TerminalMeta } from '@/stores/transient/terminal-store';
import { useTerminalStore } from '@/stores/transient/terminal-store';

/** ResizeObserver 防抖时间（ms），避免快速拖动产生多次 IPC resize */
const RESIZE_DEBOUNCE_MS = 100;

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
      theme: {
        background: '#faf7f0', // 米黄纸张底色（与 paper-texture 对齐）
        foreground: '#3d3d3d', // 墨色文字
        cursor: '#5c5c5c',
        cursorAccent: '#faf7f0',
        selectionBackground: 'rgba(93, 93, 93, 0.2)',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    // 从 store buffer 读取历史行作为兜底（接受 ANSI 序列可能错位）
    // 仅用于组件卸载重挂时恢复可见内容，新输出由 IPC 直接消费
    const { buffers } = useTerminalStore.getState();
    const initialBuffer = buffers.get(terminalId);
    if (initialBuffer !== undefined && initialBuffer.length > 0) {
      // 把历史行拼接后 write（每行加 \n 还原换行）
      term.write(initialBuffer.join('\n'));
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
