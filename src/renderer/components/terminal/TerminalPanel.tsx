import { TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Terminal as TerminalLoader } from '@/components/loading-ui/terminal';
import { Button } from '@/components/ui/button';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge } from '@/lib/ipc';
import { createTerminal, killTerminal } from '@/lib/terminal-actions';
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
  const { t } = useTranslation();
  const allTerminals = useTerminalStore((state) => state.terminals);
  const terminals = allTerminals.filter((term) => term.sessionId === sessionId);
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const createTerminalInStore = useTerminalStore((state) => state.createTerminal);
  const closeTerminalInStore = useTerminalStore((state) => state.closeTerminal);
  const workingDir = useWorkingDir(sessionId);

  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const autoCreateTriedRef = useRef(false);

  const activeId = terminals.some((term) => term.id === activeTerminalId)
    ? activeTerminalId
    : (terminals[0]?.id ?? null);

  const handleCreate = async (): Promise<void> => {
    if (creatingRef.current) return;
    if (!hasIpcBridge()) return;
    autoCreateTriedRef.current = true;
    creatingRef.current = true;
    setIsCreating(true);
    setCreateError(null);
    try {
      const { terminalId, pid, title } = await createTerminal({
        cwd: workingDir ?? undefined,
        command: undefined,
        env: undefined,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      createTerminalInStore({
        id: terminalId,
        sessionId,
        title,
        pid,
        cwd: workingDir ?? '',
        alive: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('terminal.createFailed', { message }));
      setCreateError(message);
    }
    creatingRef.current = false;
    setIsCreating(false);
  };

  const handleCreateRef = useLatestRef(handleCreate);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    if (terminals.length === 0 && !isCreating && !autoCreateTriedRef.current) {
      void handleCreateRef.current();
    }
    if (terminals.length > 0) {
      autoCreateTriedRef.current = false;
    }
  }, [terminals.length, isCreating]);

  /** 失败后重试：直接调 handleCreate（不经 effect，故不会重复触发） */
  const handleRetry = (): void => {
    void handleCreate();
  };

  const handleClose = async (terminalId: string): Promise<void> => {
    if (hasIpcBridge()) {
      try {
        await killTerminal({ terminalId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(t('terminal.closeFailed', { message }));
      }
    }
    closeTerminalInStore(terminalId);
  };

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
