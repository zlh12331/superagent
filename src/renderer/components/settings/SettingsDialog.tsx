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

import type { ApiKeyProvider, TelemetryLevel } from '@code-agent/shared/renderer';
import {
  Eye,
  EyeOff,
  Keyboard,
  KeyRound,
  Loader2,
  MessageSquareText,
  Shield,
  Trash2,
} from 'lucide-react';
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
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import { useSetTelemetryLevel, useTelemetryLevelQuery } from '@/hooks/use-telemetry';
import { cn } from '@/lib/utils';
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
interface ApiKeySectionProps {
  readonly provider: ApiKeyProvider;
  readonly label: string;
}

function ApiKeySection({ provider, label }: ApiKeySectionProps): ReactElement {
  const { data: apiKey, isLoading } = useApiKeyQuery(provider);
  const { mutate: setApiKey, isPending: isSaving } = useSetApiKey();
  const { mutate: deleteApiKey, isPending: isDeleting } = useDeleteApiKey();

  const [inputValue, setInputValue] = useState('');
  const [showPlain, setShowPlain] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setInputValue('');
    setShowPlain(false);
    setEditing(false);
  }, []);

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
          toast.success(`${label} API Key 已保存`);
          setInputValue('');
          setEditing(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(provider, {
      onSuccess: () => {
        toast.success(`${label} API Key 已删除`);
        setInputValue('');
        setEditing(false);
      },
    });
  };

  return (
    <div className="space-y-3 py-2">
      <Label htmlFor={`${provider}-api-key`} className="font-serif text-sm tracking-wide">
        {label} API Key
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
            id={`${provider}-api-key`}
            type={showPlain ? 'text' : 'password'}
            placeholder="sk-..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            autoFocus
            className="font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSaving || inputValue.trim() === ''}>
              {isSaving ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
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
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  const persistedSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);
  const updateAi = useSettingsStore((s) => s.updateAi);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const updateShortcuts = useSettingsStore((s) => s.updateShortcuts);

  const { data: telemetryLevel, isLoading: isLoadingTelemetry } = useTelemetryLevelQuery();
  const { mutate: setTelemetryLevel, isPending: isSavingTelemetry } = useSetTelemetryLevel();

  const [promptDraft, setPromptDraft] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);

  useEffect(() => {
    if (open) {
      setPromptDraft('');
      setPromptEditing(false);
    }
  }, [open]);

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

        <ApiKeySection provider="deepseek" label="DeepSeek" />
        <div className="border-t border-stone-200/60" />
        <ApiKeySection provider="openai" label="OpenAI" />

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

        {/* 遥测级别区块（隐私合规，对标 VS Code telemetryLevel） */}
        <div className="space-y-3 border-t border-stone-200/60 pt-4">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label className="font-serif text-sm tracking-wide">遥测与错误报告</Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">
            控制应用向 Sentry（自托管）上报的数据量。修改后需重启应用生效。
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                { value: 'off', label: '关闭', desc: '不上报' },
                { value: 'error-only', label: '仅错误', desc: '错误堆栈' },
                { value: 'full', label: '完整', desc: '错误+性能' },
              ] as const
            ).map((option) => {
              const isActive = telemetryLevel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={isSavingTelemetry || isLoadingTelemetry}
                  onClick={() => setTelemetryLevel(option.value as TelemetryLevel)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 text-center transition-colors',
                    isActive
                      ? 'border-stone-400 bg-stone-100/60 text-stone-800'
                      : 'border-stone-200 bg-transparent text-stone-500 hover:bg-stone-50',
                  )}
                >
                  <span className="font-serif text-xs tracking-wide">{option.label}</span>
                  <span className="text-[9px] text-muted-foreground">{option.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 快捷键设置区块（Separator 分隔：Radix 原生分隔线替代 border-t） */}
        <Separator className="my-2" />
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <Keyboard className="size-4 text-stone-600" strokeWidth={1.5} />
            <Label className="font-serif text-sm tracking-wide">快捷键</Label>
          </div>
          <p className="text-xs text-muted-foreground font-sans">
            支持 Ctrl/Cmd + 字母组合，如 Meta+P、Ctrl+S。修改后立即生效。
          </p>
          <div className="space-y-2">
            {[
              { key: 'commandPalette', label: '打开命令面板' },
              { key: 'saveFile', label: '保存文件' },
              { key: 'searchFile', label: '搜索文件' },
              { key: 'toggleTheme', label: '切换主题' },
              { key: 'openSettings', label: '打开设置' },
              { key: 'newSession', label: '新建会话' },
            ].map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-2">
                <span className="text-xs text-stone-600">{item.label}</span>
                <Input
                  type="text"
                  value={shortcuts[item.key as keyof typeof shortcuts]}
                  onChange={(e) =>
                    updateShortcuts({ [item.key]: e.target.value } as Partial<typeof shortcuts>)
                  }
                  className="w-32 font-mono text-xs"
                />
              </div>
            ))}
          </div>
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
