// src/renderer/components/terminal/TerminalPanel.tsx
// 终端面板 · 多终端标签页（对齐参考项目 TerminalPanel：TerminalTabs + TerminalView）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 展示当前 Agent 会话（sessionId）的全部终端：TerminalTabs 标签栏 + 终端视图
// - 新建终端：IPC create → 写入 store（保留会话绑定：新终端归入当前 sessionId）
// - 关闭终端：IPC kill + 移除 store
// - 切换会话时自动切换为该会话的终端集合（当前架构：终端与会话绑定）
//
// 设计（照搬参考项目）：
// - store 为多终端设计（terminals 数组 + activeTerminalId），此前 UI 仅渲染
//   每会话第一个终端；现改为全部渲染（TerminalView 同时挂载，display:none
//   切换），xterm 实例保持存活，切 Tab 无需重建、保留历史输出
// - xterm.js 实例由 TerminalView 持有，不进入 Zustand store
// ──────────────────────────────────────────────────────────────

import { TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS } from '@code-agent/shared/renderer';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

// loading-ui 终端光标动画（与 xterm 的 Terminal 类名冲突，用别名导入）
import { Terminal as TerminalLoader } from '@/components/loading-ui/terminal';
import { Button } from '@/components/ui/button';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useTerminalStore } from '@/stores/transient/terminal-store';

import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';

interface TerminalPanelProps {
  /**
   * 当前 Agent 会话 id（用于关联该会话的终端集合）
   *
   * 同一 sessionId 下可创建多个终端（多 tab），切换会话时自动切换集合。
   */
  readonly sessionId: string;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 终端默认列数（与 FitAddon 自动适配后的实际值无关，仅用于初始化；对齐 shared 单一真源） */
const DEFAULT_COLS = TERMINAL_DEFAULT_COLS;

/** 终端默认行数 */
const DEFAULT_ROWS = TERMINAL_DEFAULT_ROWS;

/**
 * 终端面板
 *
 * 集成 xterm.js（TerminalView），通过 IPC 与主进程 node-pty 通信。
 *
 * 工作流程：
 * 1. 从 store 取当前 sessionId 的全部终端
 * 2. 空：显示「创建终端」按钮
 * 3. 非空：TerminalTabs 标签栏 + 全部 TerminalView（hidden 切换激活）
 * 4. 新建 → IPC terminal:create → store.createTerminal
 * 5. 关闭 → IPC terminal:kill → store.closeTerminal
 *
 * @example
 * ```tsx
 * <TerminalPanel sessionId={activeSessionId ?? 'draft'} />
 * ```
 */
export function TerminalPanel({ sessionId, className }: TerminalPanelProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 当前会话的全部终端（store 多终端设计；对齐参考项目 TerminalPanel 多 tab 结构）
  // 注意：selector 返回 store 原始引用（稳定），过滤结果用 useMemo 缓存——
  // 直接在 selector 内 filter 会每次返回新数组，触发 useSyncExternalStore 无限循环
  const allTerminals = useTerminalStore((state) => state.terminals);
  const terminals = useMemo(
    () => allTerminals.filter((term) => term.sessionId === sessionId),
    [allTerminals, sessionId],
  );
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const createTerminalInStore = useTerminalStore((state) => state.createTerminal);
  const closeTerminalInStore = useTerminalStore((state) => state.closeTerminal);
  // P3 修复：终端 cwd 绑定本面板会话的 workingDir（唯一权威入口 useWorkingDir），
  // 此前读 file-tree rootPath 镜像：文件树未挂载时镜像为 null
  // 草稿会话 id 不在会话索引中 → null → 主进程回退用户主目录（此前硬编码 f:\TraeProjects\1）
  const workingDir = useWorkingDir(sessionId);

  // 「正在创建终端」状态（避免点击按钮后用户重复点击）
  const [isCreating, setIsCreating] = useState(false);
  // 自动创建失败后的错误文案（null = 无错误）；显示重试入口
  const [createError, setCreateError] = useState<string | null>(null);
  // ref 防重入：StrictMode 双执行 effect 时 state 未 flush，闭包读到旧值 false → 双调 IPC
  //（实测同毫秒双调 mock create → 同 id 双条目）；ref 同步写入无闭包陷阱
  const creatingRef = useRef(false);
  // 本轮「无终端」是否已尝试过自动创建（由 handleCreate 自身置位）。
  //
  // 修复（2026-09 审计）：自动创建 effect 此前仅以 `terminals.length === 0 && !isCreating`
  // 为条件，而失败后 isCreating 在同一次异步中翻回 false、terminals 仍为空 →
  // effect 立刻再次触发，形成 **IPC create 无限风暴**（实测单次失败在 20 个微任务
  // 周期内触发 12157 次 create 调用，真实环境会打爆主进程）。
  // 现改为：handleCreate 一进入就置位本标记，effect 仅在标记未置位时自动触发一次；
  // 失败后由用户点重试（重试路径直接调 handleCreate，不经 effect）。
  const autoCreateTriedRef = useRef(false);

  // 激活终端：store.activeTerminalId 属于当前会话则用之，否则回退第一个
  const activeId = terminals.some((term) => term.id === activeTerminalId)
    ? activeTerminalId
    : (terminals[0]?.id ?? null);

  // 创建终端：调用 IPC create → 写入 store
  // store.createTerminal 触发 terminals 数组变化 → TerminalView 初始化 xterm
  // P3 修复：useCallback 稳定引用（auto-create effect 依赖 handleCreate，
  // 普通函数每渲染重建会触发 effect 反复执行）
  const handleCreate = useCallback(async (): Promise<void> => {
    if (creatingRef.current) return;
    // 浏览器模式（dev 预览）无桥：不发起创建，也不进入错误态（无终端可显示）
    if (!hasIpcBridge()) return;
    // 置位「已尝试」标记：effect 据此不再自动重触发（见 autoCreateTriedRef 注释）
    autoCreateTriedRef.current = true;
    creatingRef.current = true;
    setIsCreating(true);
    setCreateError(null);
    try {
      // exactOptionalPropertyTypes：TerminalCreateReqSchema 的 command/env 虽为可选
      // 但 zod 的 .optional().transform() 让类型变为 `string | undefined`（属性必填）
      // 因此必须显式传入 undefined（表示使用默认 shell）
      const { terminalId, pid, title } = unwrap(
        await window.api.terminal.create({
          // 无激活会话时 undefined → 主进程回退用户主目录
          cwd: workingDir ?? undefined,
          command: undefined,
          env: undefined,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        }),
      );
      createTerminalInStore({
        id: terminalId,
        sessionId,
        // 标题/pid 取自主进程真实值（此前硬编码 'bash' + pid:null——
        // Windows 实际启动 powershell.exe，标签显示 bash 属事实错误）
        title,
        pid,
        cwd: workingDir ?? '',
        alive: true,
      });
    } catch (error) {
      // 终端创建失败时通过 toast 提示用户（不阻塞 UI）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.createFailed', { message }));
      // 记录错误以渲染重试入口（不再自动重试，见 autoCreateTriedRef 注释）
      setCreateError(message);
    }
    // finally 语义（React Compiler 不优化 try/finally）：catch 已吞掉全部异常
    creatingRef.current = false;
    setIsCreating(false);
  }, [workingDir, sessionId, createTerminalInStore, t]);

  // 自动创建：进入终端视图时无终端则创建一次（用户要求：点击终端 tab 直接打开终端）
  // 每轮空态只尝试一次——handleCreate 置位标记后，effect 不再自动重触发；
  // 失败由用户点重试（见 createError 分支），避免失败风暴。
  useEffect(() => {
    if (terminals.length === 0 && !isCreating && !autoCreateTriedRef.current) {
      void handleCreate();
    }
    // 有终端后重置标记：下次清空（全部关闭）时仍能自动创建
    if (terminals.length > 0) {
      autoCreateTriedRef.current = false;
    }
  }, [terminals.length, isCreating, handleCreate]);

  /** 失败后重试：直接调 handleCreate（不经 effect，故不会重复触发） */
  const handleRetry = useCallback((): void => {
    void handleCreate();
  }, [handleCreate]);

  // 关闭终端：调用 IPC kill → 从 store 移除
  const handleClose = async (terminalId: string): Promise<void> => {
    if (!hasIpcBridge()) {
      closeTerminalInStore(terminalId);
      return;
    }
    try {
      await window.api.terminal.kill({ terminalId });
    } catch (error) {
      // 关闭失败时通过 toast 提示用户，但仍从 store 移除（避免 UI 卡住）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.closeFailed', { message }));
    }
    // 无论 IPC 是否成功，都从 store 移除（避免 UI 卡住）
    closeTerminalInStore(terminalId);
  };

  // 无终端：自动创建中显示 loading；创建失败显示错误 + 重试（不再自动重试）
  if (terminals.length === 0) {
    if (createError !== null) {
      return (
        <div className={cn('flex h-full flex-col items-center justify-center gap-2', className)}>
          <span className="text-error-text text-xs">
            {t('terminal.createFailed', { message: createError })}
          </span>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        {isCreating ? (
          <TerminalLoader className="text-muted-foreground" prompt="$" />
        ) : (
          <span className="text-muted-foreground text-xs">{t('terminal.creating')}</span>
        )}
      </div>
    );
  }

  // 有终端：标签栏 + 全部终端视图（hidden 切换，保持 xterm 实例存活）
  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}>
      <TerminalTabs
        terminals={terminals}
        activeId={activeId}
        onSelect={setActiveTerminal}
        onClose={(id) => {
          void handleClose(id);
        }}
      />
      {/* 全部终端同时挂载，display:none 切换激活（照搬参考项目：xterm 实例存活 + 保留输出） */}
      <div className="min-h-0 min-w-0 flex-1">
        {terminals.map((terminal) => (
          <div
            key={terminal.id}
            className={cn('h-full', terminal.id === activeId ? 'block' : 'hidden')}
          >
            <TerminalView session={terminal} />
          </div>
        ))}
      </div>
    </div>
  );
}
