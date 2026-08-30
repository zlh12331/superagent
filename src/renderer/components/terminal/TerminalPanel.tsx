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

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

// loading-ui 终端光标动画（与 xterm 的 Terminal 类名冲突，用别名导入）
import { Terminal as TerminalLoader } from '@/components/loading-ui/terminal';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useTranslation } from '@/i18n/use-translation';
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

/** 终端默认列数（与 FitAddon 自动适配后的实际值无关，仅用于初始化） */
const DEFAULT_COLS = 80;

/** 终端默认行数 */
const DEFAULT_ROWS = 24;

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
  // ref 防重入：StrictMode 双执行 effect 时 state 未 flush，闭包读到旧值 false → 双调 IPC
  //（实测同毫秒双调 mock create → 同 id 双条目）；ref 同步写入无闭包陷阱
  const creatingRef = useRef(false);

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
    creatingRef.current = true;
    setIsCreating(true);
    try {
      // exactOptionalPropertyTypes：TerminalCreateReqSchema 的 command/env 虽为可选
      // 但 zod 的 .optional().transform() 让类型变为 `string | undefined`（属性必填）
      // 因此必须显式传入 undefined（表示使用默认 shell）
      const response = await window.api.terminal.create({
        // 无激活会话时 undefined → 主进程回退用户主目录
        cwd: workingDir ?? undefined,
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
          cwd: workingDir ?? '',
          alive: true,
        });
      }
    } catch (error) {
      // 终端创建失败时通过 toast 提示用户（不阻塞 UI）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.createFailed', { message }));
    } finally {
      creatingRef.current = false;
      setIsCreating(false);
    }
  }, [workingDir, sessionId, createTerminalInStore, t]);

  // 自动创建：进入终端视图时无终端则直接创建（用户要求：点击终端 tab 直接打开终端）
  // P3 修复：依赖表补 handleCreate（此前 biome-ignore 已失效——规则在 hook 调用位
  // 报告，忽略注释错位）；sessionId 不在依赖中（terminals 为空是全局触发条件）
  useEffect(() => {
    if (terminals.length === 0 && !isCreating) {
      void handleCreate();
    }
  }, [terminals.length, isCreating, handleCreate]);

  // 关闭终端：调用 IPC kill → 从 store 移除
  const handleClose = async (terminalId: string): Promise<void> => {
    try {
      await window.api.terminal.kill({ terminalId });
    } catch (error) {
      // 关闭失败时通过 toast 提示用户，但仍从 store 移除（避免 UI 卡住）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.closeFailed', { message }));
    } finally {
      // 无论 IPC 是否成功，都从 store 移除（避免 UI 卡住）
      closeTerminalInStore(terminalId);
    }
  };

  // 无终端：自动创建中显示 loading（用户要求：不需要"新建终端"按钮）
  if (terminals.length === 0) {
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
