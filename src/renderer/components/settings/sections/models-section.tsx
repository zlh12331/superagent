// src/renderer/components/settings/sections/models-section.tsx
// 模型服务 pane（对齐同类桌面 LLM 客户端：统一的提供商/模型管理）
// ──────────────────────────────────────────────────────────────
// 合并原「API 密钥」+「运行时模型」两个 pane：
// - 提供商列表行：每行显示配置状态徽标（已配置/未配置），
//   点击行展开 API Key 编辑（显示/隐藏/保存/删除）
// - 模型管理列表页：settings:listRuntimeModels 拉取（用户添加的模型），
//   表格 + 启停开关 + 编辑/删除 + 添加模型弹窗/配置弹窗/删除确认弹窗
// - 数据源：keychain（API Key 加密存储）+ SQLite（运行时模型持久化）
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, RuntimeModelInfo } from '@code-agent/shared/renderer';
import { Check, Eye, EyeOff, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '@/hooks/use-api-key';
import {
  useRemoveRuntimeModel,
  useRuntimeModelsQuery,
  useUpdateRuntimeModel,
} from '@/hooks/use-runtime-models';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { ApprovalModeSection } from './approval-mode-section';
import { AddModelDialog } from './dialogs/add-model-dialog';
import { ModelConfigDialog, type ModelConfigMode } from './dialogs/model-config-dialog';
import { ModelParamsSection } from './model-params-section';
import { PROVIDER_LABELS, providerLabel } from './provider-labels';

/** 配置弹窗状态（null = 关闭） */
interface ConfigDialogState {
  readonly mode: ModelConfigMode;
  readonly providerKind?: ApiKeyProvider;
  readonly editingModel?: RuntimeModelInfo;
}

/**
 * 模型服务 pane
 *
 * 提供商列表 + 模型管理列表页（增删改启停）+ 模型参数 + 审批权限。
 */
export function ModelsSection(): ReactElement {
  const { t } = useTranslation();

  // 模型管理列表（L3：settings:listRuntimeModels，用户添加的模型）
  const { data: runtimeData } = useRuntimeModelsQuery();
  const runtimeModels = runtimeData?.models ?? [];
  const updateMutation = useUpdateRuntimeModel();
  const removeMutation = useRemoveRuntimeModel();

  // 弹窗状态（L1）
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [configState, setConfigState] = useState<ConfigDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuntimeModelInfo | null>(null);

  /** 从添加弹窗选厂商 → 配置弹窗·服务商模式 */
  const handleSelectProvider = (kind: ApiKeyProvider): void => {
    setAddDialogOpen(false);
    setConfigState({ mode: 'provider', providerKind: kind });
  };

  /** 从添加弹窗选自定义 → 配置弹窗·自定义模式 */
  const handleSelectCustom = (): void => {
    setAddDialogOpen(false);
    setConfigState({ mode: 'custom' });
  };

  /** 行编辑 → 配置弹窗·编辑模式（预填） */
  const handleEdit = (model: RuntimeModelInfo): void => {
    setConfigState({ mode: 'edit', editingModel: model });
  };

  /** 启停开关：partial 更新 isEnabled（乐观由 query 失效后刷新） */
  const handleToggle = (model: RuntimeModelInfo, enabled: boolean): void => {
    updateMutation.mutate(
      { modelId: model.modelId, isEnabled: enabled },
      {
        onError: () => toast.error(t('settings.modelMgmt.saveFailed')),
      },
    );
  };

  /** 删除确认 */
  const handleConfirmDelete = (): void => {
    if (deleteTarget === null) return;
    removeMutation.mutate(deleteTarget.modelId, {
      onSuccess: () => toast.success(t('settings.modelMgmt.modelDeleted')),
      onError: () => toast.error(t('settings.modelMgmt.saveFailed')),
    });
    setDeleteTarget(null);
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* 提供商列表（内置，配置状态可视） */}
      <div>
        <Label className="font-serif text-sm tracking-wide">{t('settings.providersTitle')}</Label>
        <p className="text-muted-foreground mt-0.5 text-xs">{t('settings.providersHint')}</p>
        <div className="mt-2 flex flex-col gap-1.5">
          {PROVIDER_LABELS.map((p) => (
            <ProviderRow key={p.kind} kind={p.kind} label={p.label} />
          ))}
        </div>
      </div>

      {/* 模型管理列表页（用户添加的模型：表格 + 开关 + 增删改入口） */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="font-serif text-sm tracking-wide">
              {t('settings.modelMgmt.title')}
            </Label>
            <p className="text-muted-foreground text-xs">{t('settings.modelMgmt.hint')}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={() => setAddDialogOpen(true)}
          >
            <Plus className="size-3.5" strokeWidth={1.5} />
            {t('settings.modelMgmt.addModelTitle')}
          </Button>
        </div>

        {runtimeModels.length === 0 ? (
          <p className="text-muted-foreground border-border rounded-md border border-dashed px-3 py-6 text-center text-xs">
            {t('settings.modelMgmt.emptyHint')}
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-2xs">
                <th className="px-2 py-1.5 font-medium">{t('settings.modelMgmt.modelHeader')}</th>
                <th className="px-2 py-1.5 font-medium">
                  {t('settings.modelMgmt.providerHeader')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('settings.modelMgmt.actionsHeader')}
                </th>
              </tr>
            </thead>
            <tbody>
              {runtimeModels.map((model) => (
                <tr key={model.modelId} className="border-border border-b">
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      {/* 品牌图标：无图标数据源，用首字母色块（默认图标） */}
                      <span className="bg-accent/10 text-accent flex size-5 shrink-0 items-center justify-center rounded text-2xs font-semibold">
                        {providerLabel(model.providerKind)[0]}
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="text-foreground truncate">
                          {model.displayName ?? model.modelId}
                        </span>
                        <span className="text-muted-foreground truncate font-mono text-2xs">
                          {model.modelId}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="text-foreground px-2 py-1.5">
                    {providerLabel(model.providerKind)}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
                        aria-label={t('settings.modelMgmt.editModel')}
                        onClick={() => handleEdit(model)}
                      >
                        <Pencil className="size-3.5" strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-[var(--error)] flex size-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
                        aria-label={t('settings.modelMgmt.deleteModel')}
                        disabled={removeMutation.isPending}
                        onClick={() => setDeleteTarget(model)}
                      >
                        {removeMutation.isPending ? (
                          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
                        ) : (
                          <Trash2 className="size-3.5" strokeWidth={1.5} />
                        )}
                      </button>
                      <Switch
                        checked={model.isEnabled}
                        aria-label={t('settings.modelMgmt.toggleModel')}
                        onCheckedChange={(checked) => handleToggle(model, checked)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 模型参数（默认模型/温度/思考强度，导航收敛后并入） */}
      <div>
        <ModelParamsSection />
      </div>

      {/* 审批权限（审批模式/白名单，导航收敛后并入） */}
      <div>
        <ApprovalModeSection />
      </div>

      {/* 添加模型弹窗 */}
      <AddModelDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSelectProvider={handleSelectProvider}
        onSelectCustom={handleSelectCustom}
      />

      {/* 模型配置弹窗（服务商/自定义/编辑三模式） */}
      <ModelConfigDialog
        open={configState !== null}
        mode={configState?.mode ?? 'custom'}
        providerKind={configState?.providerKind}
        editingModel={configState?.editingModel}
        onClose={() => setConfigState(null)}
        onSaved={() => setConfigState(null)}
      />

      {/* 删除确认弹窗（无确认提示文案，仅标题 + 操作按钮） */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.modelMgmt.deleteModelTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>{t('settings.modelMgmt.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              {t('settings.modelMgmt.deleteModel')}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 单提供商行：状态徽标 + 展开编辑 API Key */
function ProviderRow({
  kind,
  label,
}: {
  readonly kind: ApiKeyProvider;
  readonly label: string;
}): ReactElement {
  const { t } = useTranslation();
  const { data: configured, isLoading } = useApiKeyQuery(kind);
  const { mutate: setApiKey, isPending: isSaving } = useSetApiKey();
  const { mutate: deleteApiKey, isPending: isDeleting } = useDeleteApiKey();

  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showPlain, setShowPlain] = useState(false);

  // P0 安全修复：主进程只返回配置状态布尔，明文不再进渲染层
  const isConfigured = configured === true;

  const handleSave = (): void => {
    if (inputValue.trim() === '') {
      toast.error(t('settings.apiKeyEmpty'));
      return;
    }
    setApiKey(
      { provider: kind, apiKey: inputValue.trim() },
      {
        onSuccess: () => {
          toast.success(t('settings.apiKeySaved', { label }));
          setInputValue('');
          setExpanded(false);
        },
      },
    );
  };

  const handleDelete = (): void => {
    deleteApiKey(kind, {
      onSuccess: () => {
        toast.success(t('settings.apiKeyDeleted', { label }));
        setExpanded(false);
      },
    });
  };

  return (
    <div className="border-border bg-muted/20 overflow-hidden rounded-md border">
      {/* 行头：名称 + 状态 + 操作（点击整行展开编辑） */}
      <button
        type="button"
        className="hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="bg-accent/10 text-accent flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold">
          {label[0]}
        </span>
        <span className="text-foreground flex-1 text-sm">{label}</span>
        {isLoading ? (
          <span className="text-muted-foreground text-2xs">…</span>
        ) : isConfigured ? (
          <span className="bg-[var(--success)]/10 text-[var(--success)] flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]">
            <Check className="size-2.5" strokeWidth={2} />
            {t('settings.providerConfigured')}
          </span>
        ) : (
          <span className="text-muted-foreground rounded-full border px-2 py-0.5 font-mono text-[10px]">
            {t('settings.providerNotConfigured')}
          </span>
        )}
        <span className="text-muted-foreground text-2xs">{expanded ? '▾' : '▸'}</span>
      </button>

      {/* 展开编辑区 */}
      {expanded && (
        <div className="border-border border-t px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Input
              type={showPlain ? 'text' : 'password'}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={
                isConfigured
                  ? t('settings.apiKeyReplacePlaceholder')
                  : t('settings.apiKeyPlaceholder')
              }
              className="min-w-0 flex-1 text-xs"
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors"
              aria-label={showPlain ? t('settings.hideApiKey') : t('settings.showApiKey')}
              onClick={() => setShowPlain((prev) => !prev)}
            >
              {showPlain ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <Button
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={handleSave}
              className="h-7 gap-1 px-2 text-xs"
            >
              {isSaving && <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />}
              {t('settings.saveApiKey')}
            </Button>
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isDeleting}
                onClick={handleDelete}
                className="text-muted-foreground hover:text-[var(--error)] h-7 gap-1 px-2 text-xs"
              >
                <Trash2 className="size-3" strokeWidth={1.5} />
                {t('settings.deleteApiKey')}
              </Button>
            )}
          </div>
          <p className={cn('text-muted-foreground mt-1 text-[10px]')}>
            {isConfigured
              ? t('settings.apiKeyConfiguredHint', { label })
              : t('settings.apiKeyNotConfiguredHint', { label })}
          </p>
        </div>
      )}
    </div>
  );
}
