// src/renderer/components/terminal/TerminalPanel.tsx
// 终端面板组件 · xterm.js 集成 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 接收 sessionId，从 useTerminalStore 查找/创建对应终端
// - 用 xterm.js 渲染终端输出（直接消费 IPC output 事件）
// - 用户输入通过 onData → IPC terminal:input 回传主进程 PTY
// - 支持关闭终端（kill PTY + 清理 store）
// - 支持自适应尺寸（ResizeObserver + fitAddon + IPC resize）
//
// 设计：
// - 单终端实例（每个 sessionId 一个 PTY，不支持多 tab）
// - xterm.js Terminal 实例由 useRef 持有，不进入 Zustand store
//   （避免 store 持有非可序列化对象）
// - 输出真源：直接订阅 IPC terminal:event:output（不走 store buffer）
//   - store buffer 仅作为兜底（用于组件卸载重挂时恢复可见内容）
// - 退出处理：监听 terminal:event:exit → store.markExited
//   （终端退出后保留输出，UI 显示「已结束」标识）
//
// 性能：
// - xterm.js 直接 write 原始 ANSI 字符串，性能最优
// - 不经过 store 中转，避免高频 set 调用
// - ResizeObserver 防抖（100ms）避免快速拖动导致多次 IPC resize
// ──────────────────────────────────────────────────────────────

// xterm.js CSS（必须在组件首次渲染前加载，否则 Terminal 实例化后样式缺失）
import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { CircleSlash, Plus, TerminalSquare, X } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { useTerminalStore } from '@/stores/transient/terminal-store';

interface TerminalPanelProps {
  /**
   * 当前 Agent 会话 id（用于关联 PTY 终端实例）
   *
   * 同一 sessionId 复用同一个 PTY，切换会话时自动切换终端。
   */
  readonly sessionId: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 终端默认工作目录（项目根，后续可改为可配置） */
const DEFAULT_CWD = 'f:\\TraeProjects\\1';

/** 终端默认列数（与 FitAddon 自动适配后的实际值无关，仅用于初始化） */
const DEFAULT_COLS = 80;

/** 终端默认行数 */
const DEFAULT_ROWS = 24;

/** ResizeObserver 防抖时间（ms），避免快速拖动产生多次 IPC resize */
const RESIZE_DEBOUNCE_MS = 100;

/**
 * 终端面板
 *
 * 集成 xterm.js，通过 IPC 与主进程 node-pty 通信。
 *
 * 工作流程：
 * 1. 检查 store 中是否有该 sessionId 的终端
 * 2. 若无：显示「创建终端」按钮
 * 3. 若有：渲染 xterm 容器 + 在 useEffect 中初始化 Terminal 实例
 * 4. Terminal 实例：
 *    - 订阅 IPC terminal:event:output → xterm.write
 *    - onData 回调 → IPC terminal:input
 *    - ResizeObserver → fitAddon.fit + IPC terminal:resize
 * 5. 关闭按钮 → IPC terminal:kill + store.closeTerminal
 *
 * @example
 * ```tsx
 * <TerminalPanel sessionId={activeSessionId ?? 'draft'} />
 * ```
 */
export function TerminalPanel({ sessionId, className }: TerminalPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 查找当前 sessionId 的终端元数据
  const terminal = useTerminalStore(
    (state) => state.terminals.find((t) => t.sessionId === sessionId) ?? null,
  );
  const createTerminalInStore = useTerminalStore((state) => state.createTerminal);
  const closeTerminalInStore = useTerminalStore((state) => state.closeTerminal);

  // xterm 容器 div 引用（用于挂载 Terminal 实例）
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 「正在创建终端」状态（避免点击按钮后用户重复点击）
  const [isCreating, setIsCreating] = useState(false);

  // 创建终端：调用 IPC create → 写入 store
  // store.createTerminal 触发 terminals 数组变化 → TerminalPanel useEffect 重新初始化 xterm
  const handleCreate = async (): Promise<void> => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      // exactOptionalPropertyTypes：TerminalCreateReqSchema 的 command/env 虽为可选
      // 但 zod 的 .optional().transform() 让类型变为 `string | undefined`（属性必填）
      // 因此必须显式传入 undefined（表示使用默认 shell）
      const response = await window.api.terminal.create({
        cwd: DEFAULT_CWD,
        command: undefined,
        env: undefined,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        const { terminalId } = response.data;
        createTerminalInStore({
          id: terminalId,
          sessionId,
          title: 'bash',
          pid: null,
          cwd: DEFAULT_CWD,
          alive: true,
        });
      }
    } catch (error) {
      // 终端创建失败时通过 toast 提示用户（不阻塞 UI）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.createFailed', { message }));
    } finally {
      setIsCreating(false);
    }
  };

  // 关闭终端：调用 IPC kill → 从 store 移除
  const handleClose = async (): Promise<void> => {
    if (terminal === null) return;
    try {
      await window.api.terminal.kill({ terminalId: terminal.id });
    } catch (error) {
      // 关闭失败时通过 toast 提示用户，但仍从 store 移除（避免 UI 卡住）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.closeFailed', { message }));
    } finally {
      // 无论 IPC 是否成功，都从 store 移除（避免 UI 卡住）
      closeTerminalInStore(terminal.id);
    }
  };

  // ── xterm.js 实例生命周期管理 ────────────────────────────
  // 依赖 terminal.id 变化时重新初始化（切换会话或新建终端时触发）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅依赖 terminal.id 变化触发重初始化，避免 terminal 对象引用变化导致频繁 dispose/recreate
  useEffect(() => {
    if (terminal === null || containerRef.current === null) return;

    const terminalId = terminal.id;
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
    const initialBuffer = useTerminalStore.getState().buffers.get(terminalId);
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
      term.write(`\r\n\x1b[2m[进程已退出，exit code: ${payload.exitCode}]\x1b[0m\r\n`);
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

    // 清理：组件卸载或 terminal.id 变化时调用
    return () => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }
      resizeObserver.disconnect();
      unsubscribeOutput();
      unsubscribeExit();
      term.dispose();
    };
  }, [terminal?.id]);

  // ── 渲染 ─────────────────────────────────────────────────

  // 无终端：显示创建按钮
  if (terminal === null) {
    return (
      <div className={className}>
        <Button
          variant="outline"
          className="w-full justify-start gap-2 font-serif tracking-wide"
          onClick={() => {
            void handleCreate();
          }}
          disabled={isCreating}
        >
          <Plus className="size-3.5" strokeWidth={1.5} />
          {isCreating ? t('terminal.creating') : t('terminal.newTerminal')}
        </Button>
      </div>
    );
  }

  // 有终端：渲染 xterm 容器 + 工具栏
  return (
    <div className={className}>
      {/* 工具栏：标题 + 关闭按钮 */}
      <div className="border-border bg-muted/30 flex items-center justify-between border-b px-2 py-1">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
          <TerminalSquare className="size-3" strokeWidth={1.5} />
          <span className="font-serif tracking-wide">{terminal.title}</span>
          {!terminal.alive && (
            <span className="text-muted-foreground/70 flex items-center gap-0.5">
              <CircleSlash className="size-2.5" strokeWidth={1.5} />
              {t('terminal.closed')}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive h-5 w-5"
          onClick={() => {
            void handleClose();
          }}
          aria-label={t('terminal.closeTerminal')}
        >
          <X className="size-3" strokeWidth={1.5} />
        </Button>
      </div>

      {/* xterm 挂载点：Terminal 实例会填充此容器 */}
      <div ref={containerRef} className="h-32 w-full overflow-hidden" />
    </div>
  );
}

// ── 兼容导出 ────────────────────────────────────────────────

/** 终端面板默认导出（便于 lazy 加载） */
