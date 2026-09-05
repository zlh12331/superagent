// src/renderer/components/settings/sections/models-section.tsx
// 模型管理 pane（文档 11-model-management-spec 蓝图形态：列表页 + 弹窗驱动）
// ──────────────────────────────────────────────────────────────
// 页面结构（文档 3.1）：标题区（主标题/副标题/说明 + 添加按钮）+ 表格 +
// 3 类弹窗（添加模型/配置三模式/删除确认）。
// 数据源：settings:listRuntimeModels（L3）；启停/编辑走 settings:updateRuntimeModel。
// API Key 配置入口在配置弹窗内（服务商模式走 settings:setApiKey）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, RuntimeModelInfo } from '@code-agent/shared/renderer';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  useRemoveRuntimeModel,
  useRuntimeModelsQuery,
  useUpdateRuntimeModel,
} from '@/hooks/use-runtime-models';
import { useTranslation } from '@/i18n/use-translation';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { AddModelDialog } from './dialogs/add-model-dialog';
import { ModelConfigDialog } from './dialogs/model-config-dialog';
import type { ModelConfigMode } from './dialogs/model-config-fields';
import { providerLabel } from './provider-labels';

/** 配置弹窗状态（null = 关闭） */
interface ConfigDialogState {
  readonly mode: ModelConfigMode;
  readonly providerKind?: ApiKeyProvider;
  readonly editingModel?: RuntimeModelInfo;
}

/**
 * 模型管理 pane（文档蓝图形态：标题区 + 表格 + 3 弹窗）
 */
export function ModelsSection(): ReactElement {
  const { t } = useTranslation();

  // 模型管理列表（L3：settings:listRuntimeModels，用户配置的模型记录）
  // 说明：服务商模式保存的模型也落 runtimeModelStore（providerKind + 具体 modelId，
  // API Key 走厂商级 keychain）——"配置一个模型显示一条记录"，不并入未配置的内置模型。
  const { data: runtimeData } = useRuntimeModelsQuery();
  const runtimeModels = runtimeData?.models ?? [];
  const updateMutation = useUpdateRuntimeModel();
  const removeMutation = useRemoveRuntimeModel();

  // 弹窗状态（L1）
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [configState, setConfigState] = useState<ConfigDialogState | null>(null);

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
    // onError 由 hook 层统一 toast（unwrapErrorMessage 本地化），调用层不重复
    updateMutation.mutate({ modelId: model.modelId, isEnabled: enabled });
  };

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* 模型管理列表页（文档 3.1.2：标题区 + 表格） */}
      <div className="flex flex-col gap-2">
        {/* 标题区：主标题 + 副标题 + 说明 + 添加按钮 */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-foreground text-lg font-bold tracking-wide">
              {t('settings.modelMgmt.mainTitle')}
            </h2>
            <h3 className="text-foreground text-sm font-semibold">
              {t('settings.modelMgmt.title')}
            </h3>
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
                      <span className="bg-accent/10 text-accent-text flex size-5 shrink-0 items-center justify-center rounded text-2xs font-semibold">
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
                        className="text-muted-foreground hover:text-error-text flex size-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
                        aria-label={t('settings.modelMgmt.deleteModel')}
                        disabled={removeMutation.isPending}
                        onClick={() => {
                          // 破坏性操作统一 confirm() store（收敛此前内联 AlertDialog 双轨）
                          void confirm({
                            title: t('settings.modelMgmt.deleteModelTitle'),
                            message: t('common.deleteConfirmDesc'),
                            danger: true,
                          }).then((ok) => {
                            if (ok)
                              removeMutation.mutate(model.modelId, {
                                onSuccess: () =>
                                  toast.success(t('settings.modelMgmt.modelDeleted')),
                              });
                          });
                        }}
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
    </div>
  );
}
