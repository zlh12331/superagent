// api-key-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ApiKeySection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';
import { Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import { useTranslation } from '@/i18n/use-translation';

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

export function ApiKeySection({ provider, label }: ApiKeySectionProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
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
      toast.error(t('settings.apiKeyEmpty'));
      return;
    }
    setApiKey(
      { provider, apiKey: inputValue.trim() },
      {
        onSuccess: () => {
          toast.success(t('settings.apiKeySaved', { label }));
          setInputValue('');
          setEditing(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(provider, {
      onSuccess: () => {
        toast.success(t('settings.apiKeyDeleted', { label }));
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
          <span className="text-sm">{t('common.loading')}</span>
        </div>
      ) : isConfigured && !editing ? (
        <div className="space-y-2">
          <div className="bg-muted/40 flex items-center justify-between rounded-md border px-3 py-2 font-mono text-sm">
            <span className="truncate">{maskApiKey(apiKey ?? '')}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
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
              {t('settings.modify')}
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
              {t('common.delete')}
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
              {t('common.save')}
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
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
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
