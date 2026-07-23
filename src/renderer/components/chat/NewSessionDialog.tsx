// src/renderer/components/chat/NewSessionDialog.tsx
// 新对话对话框：最近目录列表 + 浏览其他
// ──────────────────────────────────────────────────────────────
// 职责：
// - 打开时查询最近目录列表（useRecentDirs）
// - 有历史：展示目录列表（每项显示路径 basename + 最后使用时间）
// - 无历史：自动触发目录选择器
// - 点击历史项 → createSession → 跳转 /chat/:id
// - 点击"浏览其他" → pickDirectory → createSession → 跳转
// - 用户取消选择：保持对话框打开
//
// 设计：
// - open=true 时挂载并查询（TanStack Query 自动缓存）
// - loading 时不触发自动 pickDirectory（避免 loading 时误弹）
// - 取消后：dirs.length===0 显示空状态提示，dirs.length>0 回到列表
// ──────────────────────────────────────────────────────────────

import { Folder, Plus } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useCreateSession, useRecentDirs } from '@/hooks/use-sessions';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 路径 basename（跨平台，取最后一段） */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 相对时间格式化 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function NewSessionDialog({ open, onOpenChange }: NewSessionDialogProps): ReactElement {
  const navigate = useNavigate();
  const { data: recentDirsData, isLoading: dirsLoading } = useRecentDirs();
  const { mutateAsync: createSession, isPending: isCreating } = useCreateSession();
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);

  const [autoPickedTriggered, setAutoPickedTriggered] = useState(false);

  // 跟踪对话框 open 状态的 ref（用于异步操作完成后判断是否仍需执行副作用）
  // 解决竞态：用户在 createSession 进行中关闭对话框时，不应继续 navigate
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const dirs = recentDirsData?.dirs ?? [];

  // 创建会话并跳转
  const handleCreate = useCallback(
    async (workingDir: string) => {
      try {
        const { sessionId } = await createSession({ workingDir });
        // 竞态守卫：若用户在 createSession 进行中关闭了对话框，不执行后续副作用
        if (!openRef.current) return;
        setActiveSession(sessionId);
        navigate(ROUTES.chatPath(sessionId));
        onOpenChange(false);
      } catch {
        // onError 已在 useCreateSession 中 toast 提示
        // 对话框保持打开，允许重试
      }
    },
    [createSession, navigate, onOpenChange, setActiveSession],
  );

  // 浏览其他目录
  const handleBrowse = useCallback(async () => {
    try {
      const response = await window.api.dialog.pickDirectory({});
      if ('error' in response) {
        toast.error(`[${response.error.code}] ${response.error.message}`);
        return;
      }
      if (response.data.canceled || response.data.path === undefined) {
        // 用户取消：保持对话框打开，不报错
        return;
      }
      await handleCreate(response.data.path);
    } catch (error) {
      // 捕获 IPC 调用本身的异常（如 preload bridge 未就绪）
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [handleCreate]);

  // 无历史时自动触发目录选择器（仅在数据加载完成 + 尚未触发过时执行）
  useEffect(() => {
    if (open && !dirsLoading && dirs.length === 0 && !autoPickedTriggered && !isCreating) {
      setAutoPickedTriggered(true);
      void handleBrowse();
    }
    // 对话框关闭后重置标志，下次打开可重新触发
    if (!open) {
      setAutoPickedTriggered(false);
    }
  }, [open, dirsLoading, dirs.length, autoPickedTriggered, isCreating, handleBrowse]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>开始新对话</DialogTitle>
          <DialogDescription>选择一个项目目录开始</DialogDescription>
        </DialogHeader>

        {dirsLoading ? (
          <LoadingList />
        ) : dirs.length === 0 ? (
          <EmptyState onBrowse={handleBrowse} isCreating={isCreating} />
        ) : (
          <div className="flex flex-col gap-1">
            {dirs.map((dir) => (
              <button
                key={dir.workingDir}
                type="button"
                onClick={() => handleCreate(dir.workingDir)}
                disabled={isCreating}
                className={cn(
                  'hover:bg-accent flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <Folder className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate text-sm font-medium">
                    {basename(dir.workingDir)}
                  </div>
                  <div className="text-muted-foreground truncate text-xs" title={dir.workingDir}>
                    {dir.workingDir}
                  </div>
                </div>
                <span className="text-muted-foreground/70 shrink-0 text-[10px]">
                  {formatRelativeTime(dir.lastUsed)}
                </span>
              </button>
            ))}

            <div className="border-t pt-2 mt-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                onClick={handleBrowse}
                disabled={isCreating}
              >
                <Plus className="size-4" strokeWidth={1.5} />
                浏览其他...
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LoadingList(): ReactElement {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 3 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function EmptyState({
  onBrowse,
  isCreating,
}: {
  onBrowse: () => void;
  isCreating: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-4 p-6 text-center">
      <Folder className="text-muted-foreground size-10" strokeWidth={1} />
      <p className="text-muted-foreground text-sm">请选择一个项目目录开始</p>
      <Button variant="outline" onClick={onBrowse} disabled={isCreating}>
        <Plus className="size-4" strokeWidth={1.5} />
        浏览目录
      </Button>
    </div>
  );
}
