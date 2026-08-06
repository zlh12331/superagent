// runtime-models-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · RuntimeModelsSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { ListRuntimeModelsRes } from '@code-agent/shared/renderer';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

export function RuntimeModelsSection(): ReactElement {
  const { t } = useTranslation();
  const [models, setModels] = useState<ListRuntimeModelsRes['models'] | null>(null);
  const [modelId, setModelId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [adding, setAdding] = useState(false);

  const loadModels = useCallback(() => {
    window.api.settings
      .listRuntimeModels()
      .then((res) => {
        setModels(unwrap<ListRuntimeModelsRes>(res).models);
      })
      .catch(() => {
        toast.error(t('settings.runtimeModelLoadFailed'));
      });
  }, [t]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleAdd = async (): Promise<void> => {
    if (modelId.trim().length === 0) {
      return;
    }
    setAdding(true);
    try {
      await window.api.settings.addRuntimeModel({
        modelId: modelId.trim(),
        providerKind: 'openai',
        // zod transform 输出为 string | undefined：显式传 undefined
        baseUrl: baseUrl.trim().length > 0 ? baseUrl.trim() : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      });
      toast.success(t('settings.runtimeModelAdded'));
      setModelId('');
      setBaseUrl('');
      setApiKey('');
      loadModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string): Promise<void> => {
    try {
      await window.api.settings.removeRuntimeModel({ modelId: id });
      toast.success(t('settings.runtimeModelRemoved'));
      loadModels();
    } catch {
      toast.error(t('settings.runtimeModelLoadFailed'));
    }
  };

  const isEmpty = models === null || models.length === 0;

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <Plus className="size-4 text-stone-600" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.runtimeModelsSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.runtimeModelsHint')}</p>

      {/* 添加表单 */}
      <div className="space-y-1.5">
        <Input
          type="text"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={t('settings.runtimeModelIdPlaceholder')}
          className="font-mono text-xs"
        />
        <Input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t('settings.runtimeModelBaseUrlPlaceholder')}
          className="font-mono text-xs"
        />
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('settings.runtimeModelApiKeyPlaceholder')}
          className="font-mono text-xs"
        />
        <Button variant="outline" size="sm" onClick={handleAdd} disabled={adding}>
          {adding ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Plus className="size-3.5" strokeWidth={1.5} />
          )}
          {t('settings.runtimeModelAdd')}
        </Button>
      </div>

      {/* 模型列表 */}
      {isEmpty ? (
        <p className="text-xs text-muted-foreground font-sans">
          {t('settings.runtimeModelsEmpty')}
        </p>
      ) : (
        <ul className="space-y-1 text-xs font-sans">
          {models.map((m) => (
            <li
              key={m.modelId}
              className="flex items-center justify-between gap-2 rounded border border-stone-100 px-2 py-1"
            >
              <span className="truncate text-stone-700">
                {m.modelId}
                <span className="ml-1 text-muted-foreground">({m.providerKind})</span>
              </span>
              <button
                type="button"
                onClick={() => void handleRemove(m.modelId)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('settings.runtimeModelRemove')}
              >
                <Trash2 className="size-3.5" strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * IM 渠道区块：渠道列表 / 启停 / token 配置
 *
 * 数据来源：im:list / start / stop（token 存 keychain，不落库）。
 */
