// prompt-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · Code Agent 系统提示词编辑
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import { MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 系统提示词区块（Code Agent 专用） */
export function PromptSection({ open }: { open: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const persistedSystemPrompt = useSettingsStore((s) => s.ai.systemPrompt);
  const updateAi = useSettingsStore((s) => s.updateAi);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);

  useEffect(() => {
    if (open) {
      setPromptDraft('');
      setPromptEditing(false);
    }
  }, [open]);

  const handlePromptEdit = (): void => {
    setPromptDraft(persistedSystemPrompt);
    setPromptEditing(true);
  };

  const handlePromptSave = (): void => {
    updateAi({ systemPrompt: promptDraft });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success(t('settings.promptSaved'));
  };

  const handlePromptClear = (): void => {
    updateAi({ systemPrompt: '' });
    setPromptEditing(false);
    setPromptDraft('');
    toast.success(t('settings.promptReset'));
  };

  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <MessageSquareText className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label htmlFor="system-prompt" className="font-serif text-sm tracking-wide">
          {t('settings.systemPrompt')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.systemPromptHint')}</p>

      {promptEditing ? (
        <div className="space-y-2">
          <Textarea
            id="system-prompt"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            placeholder={t('settings.systemPromptPlaceholder')}
            rows={6}
            className="font-mono text-xs"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handlePromptSave}>
              {t('common.save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPromptEditing(false);
                setPromptDraft('');
              }}
            >
              {t('common.cancel')}
            </Button>
            {promptDraft.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePromptClear}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {t('settings.clear')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            {persistedSystemPrompt.length > 0 ? (
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                {persistedSystemPrompt}
              </pre>
            ) : (
              <span className="text-xs italic text-muted-foreground">
                {t('settings.useDefaultPrompt')}
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={handlePromptEdit}>
            {persistedSystemPrompt.length > 0 ? t('settings.modify') : t('settings.set')}
          </Button>
        </div>
      )}
    </div>
  );
}
