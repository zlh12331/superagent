// src/renderer/routes/chat.tsx
// AI 对话路由（AI 对话工作台）
// 设计文档 §3 路由结构 + §5.1 场景 3 AI 流式对话 + §6.2 ChatSession / ChatMessage 模型
//
// 职责：
// - 通过 useChatSessionList 加载会话列表，渲染 Loading / Error / 工作台三种状态
// - 左侧 ChatSessionList：会话列表 + 新建/删除入口
// - 右侧 ChatMessageList + ChatInputArea：消息流 + 输入区
// - 新建会话：Dialog 收集 title，调 useCreateChatSession，成功后切换到新会话
// - 发送消息：调 useSendChatMessage，触发后端流式生成
// - 停止生成：调 useStopChatGeneration
// - 切换会话时调 clearSession 清理旧会话的流式状态（避免内存泄漏）
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { ChatSessionCreateInput } from '@novel-writer/shared';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';

import { ChatInputArea } from '@/components/chat/ChatInputArea';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { ChatSessionList } from '@/components/chat/ChatSessionList';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChatMessages } from '@/hooks/use-chat-messages';
import {
  useChatSessionList,
  useCreateChatSession,
  useDeleteChatSession,
  useSendChatMessage,
  useStopChatGeneration,
} from '@/hooks/use-chat-sessions';
import { handleIpcError } from '@/lib/handle-ipc-error';
import { useChatStreamStore } from '@/stores/chat-stream.store';

/**
 * AI 对话页面（AI 对话工作台）
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 空会话列表：展示 ChatSessionList（含 EmptyState）+ 右侧引导
 * - 正常：展示左侧会话列表 + 右侧消息流 + 输入区
 */
export function Component(): ReactElement {
  const { projectId } = useParams();
  // useParams 返回 string | undefined，hooks 接受 string | null | undefined
  // 此处直接透传，由 hook 内部 enabled 控制

  // 当前选中会话 ID（null 表示未选中，列表加载后自动选中第一个）
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // 新建会话对话框开关
  const [createOpen, setCreateOpen] = useState(false);
  // 待删除会话 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // 数据 hooks
  const { data: sessions, isLoading, error, refetch } = useChatSessionList(projectId);
  const { data: messages } = useChatMessages(activeSessionId);
  const { mutateAsync: createSessionAsync, isPending: isCreating } = useCreateChatSession();
  const { mutateAsync: sendAsync } = useSendChatMessage();
  const { mutateAsync: stopAsync } = useStopChatGeneration();
  const { mutateAsync: deleteSessionAsync } = useDeleteChatSession();

  // isStreaming 状态：从 chat-stream.store 获取 activeSessionId 的状态
  // 仅当当前会话处于 streaming 时为 true，控制 ChatInputArea 显示发送/停止按钮
  const isStreaming = useChatStreamStore((s) =>
    activeSessionId ? s.statusBySession[activeSessionId] === 'streaming' : false,
  );
  const clearSession = useChatStreamStore((s) => s.clearSession);

  // 用 ref 保存上一个 activeSessionId，用于切换会话时清理旧会话的流式状态
  const prevSessionIdRef = useRef<string | null>(null);

  /**
   * 自动选中第一个会话
   *
   * 当会话列表加载完成且 activeSessionId 为 null 时，选中第一个会话
   * 也处理 active session 被删除后自动切换到第一个可用会话
   */
  useEffect(() => {
    if (sessions === undefined) return;
    if (sessions.length === 0) {
      // 列表为空：清空选中
      if (activeSessionId !== null) {
        setActiveSessionId(null);
      }
      return;
    }
    // activeSessionId 为 null 或不在列表中（已删除）→ 选中第一个
    const exists = activeSessionId !== null && sessions.some((s) => s.id === activeSessionId);
    if (!exists) {
      const first = sessions[0];
      if (first) {
        setActiveSessionId(first.id);
      }
    }
  }, [sessions, activeSessionId]);

  /**
   * 切换会话时清理旧会话的流式状态
   *
   * 依赖 activeSessionId：当 ID 变化时，清理上一个会话的 chunks/status/error，
   * 避免内存泄漏与切换回旧会话时显示陈旧的流式文本。
   */
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    if (prev !== null && prev !== activeSessionId) {
      clearSession(prev);
    }
    prevSessionIdRef.current = activeSessionId;
  }, [activeSessionId, clearSession]);

  /**
   * 新建会话
   *
   * 调 useCreateChatSession 创建，成功后切换到新会话并关闭对话框
   * 失败时通过 handleIpcError 显示 toast，不关闭对话框让用户重试
   */
  const handleCreate = async (title: string): Promise<void> => {
    if (!projectId) return;
    const input: ChatSessionCreateInput = {
      projectId,
      title: title.trim(),
    };
    try {
      const session = await createSessionAsync(input);
      setActiveSessionId(session.id);
      setCreateOpen(false);
    } catch (err) {
      handleIpcError(err);
    }
  };

  /**
   * 发送消息
   *
   * 调 useSendChatMessage 触发后端流式生成
   * 失败时通过 handleIpcError 显示 toast
   */
  const handleSend = (content: string): void => {
    if (!activeSessionId) return;
    void sendAsync({ sessionId: activeSessionId, content }).catch(handleIpcError);
  };

  /**
   * 停止生成
   *
   * 调 useStopChatGeneration 停止当前会话的流式生成
   * 失败时通过 handleIpcError 显示 toast
   */
  const handleStop = (): void => {
    if (!activeSessionId) return;
    void stopAsync(activeSessionId).catch(handleIpcError);
  };

  /**
   * 删除会话
   *
   * 流程：
   * 1. 调 deleteSessionAsync 触发主进程级联删除（含消息 + 中断活跃流）
   * 2. 删除成功后清理 chat-stream.store 中该会话的流式状态
   * 3. 若删除的是当前 active session，由上方 useEffect 自动切换到第一个可用会话
   * 4. ConfirmDialog 成功后自动关闭，失败时不关闭（让用户可重试）
   */
  const handleDelete = async (): Promise<void> => {
    if (deleteTarget === null || !projectId) return;
    const targetId = deleteTarget;
    try {
      await deleteSessionAsync({ id: targetId, projectId });
      // 清理该会话的流式状态（chunks / status / error）
      clearSession(targetId);
      toast.success('会话已删除');
    } catch (err) {
      handleIpcError(err);
      // 重新抛出让 ConfirmDialog 不关闭
      throw err;
    }
  };

  // 加载中：展示旋转加载占位
  if (isLoading) {
    return <LoadingSpinner label="正在加载会话列表..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // 空会话列表：左侧引导新建（ChatSessionList 内部 EmptyState），右侧引导选择
  if (sessions === undefined || sessions.length === 0) {
    return (
      <>
        <div className="flex h-full">
          <ChatSessionList
            projectId={projectId ?? ''}
            sessions={[]}
            activeSessionId={null}
            onSelectSession={() => undefined}
            onCreateClick={() => setCreateOpen(true)}
            onDeleteSession={() => undefined}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <ChatMessageList sessionId={null} messages={[]} />
          </main>
        </div>
        <ChatCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSubmit={handleCreate}
          isPending={isCreating}
        />
      </>
    );
  }

  return (
    <div className="flex h-full">
      {/* 左侧：会话列表侧边栏（固定宽度 256px） */}
      <ChatSessionList
        projectId={projectId ?? ''}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onCreateClick={() => setCreateOpen(true)}
        onDeleteSession={(id) => setDeleteTarget(id)}
      />
      {/* 右侧：消息流 + 输入区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatMessageList sessionId={activeSessionId} messages={messages ?? []} />
        <ChatInputArea
          sessionId={activeSessionId}
          isStreaming={isStreaming}
          onSend={handleSend}
          onStop={handleStop}
        />
      </main>
      {/* 新建会话对话框（受控） */}
      <ChatCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
        isPending={isCreating}
      />
      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除会话"
        description="确定删除此会话？所有消息将一并删除，此操作不可恢复。"
        onConfirm={handleDelete}
      />
    </div>
  );
}

/**
 * 新建会话对话框 Props
 *
 * 内联在 chat.tsx 中（仅此页面使用），收集 title 字段后调用 onSubmit
 */
interface ChatCreateDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
  /** 提交回调（入参为去除首尾空白的标题） */
  onSubmit: (title: string) => void | Promise<void>;
  /** 是否正在提交（创建中） */
  isPending: boolean;
}

/**
 * 新建会话对话框
 *
 * 受控模式，title 必填（maxLength 200）。
 * 提交时调 onSubmit；创建中禁用取消按钮与关闭手势，避免半途打断。
 */
function ChatCreateDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: ChatCreateDialogProps): ReactElement {
  // 标题本地状态
  const [title, setTitle] = useState('');

  /**
   * 提交表单
   * - 空白标题不提交
   * - 提交后清空标题（无论成功失败，由父组件控制对话框关闭时机）
   */
  const handleSubmit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    await onSubmit(trimmed);
    setTitle('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 创建中不允许关闭，避免半途打断 mutation
        if (!isPending) onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>为这次 AI 对话起一个标题，便于后续查找</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 py-2">
          <Label htmlFor="chat-session-title">会话标题 *</Label>
          <Input
            id="chat-session-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：第 1 章续写讨论"
            maxLength={200}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={isPending || title.trim().length === 0}
          >
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'ChatPage';
