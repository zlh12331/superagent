// src/renderer/components/settings/SettingsDialog.tsx
// 设置对话框 · API Key 管理 + 系统提示词管理
// ──────────────────────────────────────────────────────────────
// 职责：
// - 受控 Dialog：由父组件通过 open / onOpenChange 控制开关
// - 内嵌 DeepSeek API Key 输入 / 保存 / 删除 / 状态展示
// - 内嵌 Code Agent 系统提示词编辑（覆盖默认 system prompt）
// - 通过 TanStack Query 管理 IPC 请求状态，自动失效缓存
//
// 设计：
// - 极简文学风：衬线字体标题、米色纸张背景、墨色文字点缀
// - 安全：API Key 输入框默认隐藏，点击眼睛图标切换显隐
// - 反馈：保存 / 删除成功后 toast 提示
// ──────────────────────────────────────────────────────────────

import { Eye, EyeOff, KeyRound, Loader2, MessageSquareText, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';

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
import { Textarea } from '@/components/ui/textarea';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import { useSettingsStore } from '@/stores/persistent/settings-store';

interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 切换打开状态 */
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * 掩码显示已设置的 API Key
 *
 * 只展示前 4 位与后 4 位，中间用 ··· 连接。
 * 既让用户能确认 Key 已设置，又不暴露完整明文。
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '·'.repeat(key.length);
  return `${key.slice(0, 4)}${'·'.repeat(Math.min(12, key.length - 8))}${key.slice(-4)}`;
}

/**
 * 设置对话框组件
 *
 * 当前仅包含 DeepSeek API Key 管理面板，后续可扩展更多设置项。
 *
 * @example
 * ```tsx
 * const [open, setOpen] = useState(false);
 * return (
 *   <>
 *     <Button onClick={() => setOpen(true)}>设置</Button>
 *     <SettingsDialog open={open} onOpenChange={setOpen} />
 *   </>
 * );
 * ```
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  // 当前仅支持 deepseek，后续扩展时改为动态枚举
  const provider = 'deepseek' as const;

  const { data: apiKey, isLoading } = useApiKeyQuery(provider);
  const { mutate: setApiKey, isPending: isSaving } = useSetApiKey();
  const { mutate: deleteApiKey, isPending: isDeleting } = useDeleteApiKey();

  // settings store：读取 / 更新 systemPrompt
  const persistedSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);
  const updateAi = useSettingsStore((s) => s.updateAi);

  // 本地输入状态（受控输入框）
  const [inputValue, setInputValue] = useState('');
  // 是否显示明文（眼睛图标切换）
  const [showPlain, setShowPlain] = useState(false);
  // 是否处于编辑模式（已配置时默认不展示输入框，点击"修改"进入编辑）
  const [editing, setEditing] = useState(false);

  // 系统提示词本地编辑状态（独立于 API Key 编辑状态）
  const [promptDraft, setPromptDraft] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);

  // 对话框打开时重置本地状态
  // apiKey 变化（如首次加载完成）也同步重置 inputValue
  useEffect(() => {
    if (open) {
      setInputValue('');
      setShowPlain(false);
      setEditing(false);
      setPromptDraft('');
      setPromptEditing(false);
    }
  }, [open]);

  const isConfigured = apiKey !== null && apiKey !== undefined && apiKey !== '';

  const handleSave = (): void => {
    if (inputValue.trim() === '') {
      toast.error('API Key 不能为空');
      return;
    }
    setApiKey(
      { provider, apiKey: inputValue.trim() },
      {
        onSuccess: () => {
          toast.success('API Key 已保存');
          setInputValue('');
          setEditing(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(provider, {
      onSuccess: () => {
        toast.success('API Key 已删除');
        setInputValue('');
        setEditing(false);
      },
    });
  };

  // 系统提示词：进入编辑时，加载当前持久化值到 draft
  const handlePromptEdit = (): void => {
    setPromptDraft(persistedSystemPrompt);
    setPromptEditing(true);
  };

  // 系统提示词：保存到 settings store
  const handlePromptSave = (): void => {
    updateAi({ systemPrompt: promptDraft });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success('系统提示词已保存');
  };

  // 系统提示词：清空（恢复使用默认 system prompt）
  const handlePromptClear = (): void => {
    updateAi({ systemPrompt: '' });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success('已恢复使用默认系统提示词');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif tracking-wide">
            <KeyRound className="size-4" strokeWidth={1.5} />
            <span>设置</span>
          </DialogTitle>
          <DialogDescription className="font-serif">
            管理 API Key 等敏感数据。主进程通过系统钥匙串加密存储，重启后依然可用。
          </DialogDescription>
        </DialogHeader>

        {/* DeepSeek API Key 区块 */}
        <div className="space-y-3 py-2">
          <Label htmlFor="deepseek-api-key" className="font-serif text-sm tracking-wide">
            DeepSeek API Key
          </Label>

          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
              <span className="text-sm">加载中...</span>
            </div>
          ) : isConfigured && !editing ? (
            <div className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between rounded-md border px-3 py-2 font-mono text-sm">
                <span className="truncate">{maskApiKey(apiKey ?? '')}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={showPlain ? '隐藏 API Key' : '显示 API Key'}
                  onClick={() => setShowPlain((v) => !v)}
                >
                  {showPlain ? (
                    <EyeOff className="size-3.5" strokeWidth={1.5} />
                  ) : (
                    <Eye className="size-3.5" strokeWidth={1.5} />
                  )}
                </Button>
              </div>
              {showPlain && (
                <div className="bg-muted/30 break-all rounded-md border px-3 py-2 font-mono text-xs">
                  {apiKey}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(true);
                    setInputValue('');
                  }}
                >
                  修改
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {isDeleting ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                  ) : (
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  )}
                  删除
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                id="deepseek-api-key"
                type={showPlain ? 'text' : 'password'}
                placeholder="sk-..."
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                autoFocus
                className="font-mono"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || inputValue.trim() === ''}
                >
                  {isSaving ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                  ) : null}
                  保存
                </Button>
                {isConfigured && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(false);
                      setInputValue('');
                    }}
                  >
                    取消
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={showPlain ? '隐藏 API Key' : '显示 API Key'}
                  onClick={() => setShowPlain((v) => !v)}
                >
                  {showPlain ? (
                    <EyeOff className="size-3.5" strokeWidth={1.5} />
                  ) : (
                    <Eye className="size-3.5" strokeWidth={1.5} />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 系统提示词区块（Code Agent 专用） */}
        <div className="space-y-3 border-t border-stone-200/60 pt-4">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label htmlFor="system-prompt" className="font-serif text-sm tracking-wide">
              系统提示词（Code Agent）
            </Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">
            自定义 Agent 行为。留空则使用主进程内置默认 system prompt。
          </p>

          {promptEditing ? (
            <div className="space-y-2">
              <Textarea
                id="system-prompt"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                placeholder="例如：你是一个专注于 TypeScript 代码审查的助手，请使用中文回复..."
                rows={6}
                className="font-mono text-xs"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handlePromptSave}>
                  保存
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPromptEditing(false);
                    setPromptDraft('');
                  }}
                >
                  取消
                </Button>
                {promptDraft.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePromptClear}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    清空
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                {persistedSystemPrompt.length > 0 ? (
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-stone-700">
                    {persistedSystemPrompt}
                  </pre>
                ) : (
                  <span className="text-xs italic text-muted-foreground">
                    （使用默认 system prompt）
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handlePromptEdit}>
                {persistedSystemPrompt.length > 0 ? '修改' : '设置'}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
