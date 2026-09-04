// src/renderer/components/settings/sections/dialogs/model-config-dialog.tsx
// 模型配置弹窗（统一表单 · 服务商/自定义/编辑三模式）
// ──────────────────────────────────────────────────────────────
// 保存流程（文档 3.3.3 已定）：校验 → 连通性测试（失败阻止提交并标红）
// → add/update → 失效 RUNTIME_MODELS_QUERY_KEY + MODELS_QUERY_KEY。
// 高级配置区字段首版不持久化（文档 3.3.4 字段映射），仅表单交互。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, RuntimeModelInfo } from '@code-agent/shared/renderer';
import { Loader2, TriangleAlert } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSetApiKey } from '@/hooks/use-api-key';
import { useBuiltinModelsQuery } from '@/hooks/use-models';
import {
  useAddRuntimeModel,
  useTestModel,
  useUpdateRuntimeModel,
} from '@/hooks/use-runtime-models';
import { useTranslation } from '@/i18n/use-translation';
import { providerApiKeyUrl } from '../provider-labels';
import {
  ModelConfigFields,
  type ModelConfigFormValues,
  type ModelConfigMode,
} from './model-config-fields';

export interface ModelConfigDialogProps {
  readonly open: boolean;
  /** 弹窗模式（edit 时 editingModel 必传） */
  readonly mode: ModelConfigMode;
  /** 服务商模式：进入时选定的厂商（非服务商模式为 undefined） */
  readonly providerKind: ApiKeyProvider | undefined;
  /** 编辑模式：被编辑的模型（非编辑模式为 undefined） */
  readonly editingModel: RuntimeModelInfo | undefined;
  readonly onClose: () => void;
  /** 保存成功后回调（父层关闭弹窗） */
  readonly onSaved: () => void;
}

/** 默认表单值（新增模式起点） */
function createDefaultValues(): ModelConfigFormValues {
  return {
    providerKind: 'deepseek',
    selectedModel: '',
    useOtherModel: false,
    modelId: '',
    displayName: '',
    requestUrl: '',
    apiKey: '',
    contextInput: '',
    contextOutput: '',
    toolCallRounds: '',
    imageSupport: 'support',
    thinkingMode: 'follow',
    temperature: '',
    topP: '',
    topK: '',
  };
}

/**
 * 模型配置弹窗
 *
 * - 服务商模式：选厂商进入，显示厂商/模型下拉 + 模型 ID + API 密钥
 * - 自定义模式：显示 API 格式（固定 OpenAI Chat Completions）+ 请求地址 + 模型 ID/名称/密钥
 * - 编辑模式：预填已有配置，modelId/providerKind 只读，按钮变「保存」
 */
export function ModelConfigDialog({
  open,
  mode,
  providerKind,
  editingModel,
  onClose,
  onSaved,
}: ModelConfigDialogProps): ReactElement {
  const { t } = useTranslation();
  const addMutation = useAddRuntimeModel();
  const updateMutation = useUpdateRuntimeModel();
  const testMutation = useTestModel();
  const setApiKeyMutation = useSetApiKey();

  const [values, setValues] = useState<ModelConfigFormValues>(createDefaultValues);
  const [errors, setErrors] = useState<{ readonly modelId?: string; readonly test?: string }>({});
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [testing, setTesting] = useState(false);

  // 服务商模式：厂商内置模型全集（listBuiltin，不依赖 keychain——
  // 配置页为未配置用户服务；此前误用 models:list 的"已配置才显示"过滤导致死锁）
  const { data: builtinData } = useBuiltinModelsQuery(
    mode === 'provider' ? values.providerKind : undefined,
  );

  const isEdit = mode === 'edit';
  const isCustom = mode === 'custom';
  const isProviderMode = mode === 'provider';

  // 打开时按模式初始化表单（编辑模式预填；切换弹窗重置）
  useEffect(() => {
    if (!open) return;
    if (isEdit && editingModel !== undefined) {
      setValues({
        ...createDefaultValues(),
        providerKind: editingModel.providerKind,
        modelId: editingModel.modelId,
        displayName: editingModel.displayName ?? '',
        requestUrl: editingModel.baseUrl ?? '',
      });
    } else {
      setValues({
        ...createDefaultValues(),
        ...(providerKind !== undefined ? { providerKind } : {}),
      });
    }
    setErrors({});
    setAdvancedExpanded(false);
  }, [open, isEdit, editingModel, providerKind]);

  /** 当前厂商的内置模型全集（服务商模式下拉；listBuiltin 已按厂商过滤） */
  const providerModels = useMemo(() => {
    if (isCustom || isEdit) return [];
    return builtinData?.models ?? [];
  }, [builtinData, isCustom, isEdit]);

  /** 服务商模式：下拉选中的模型 id（未选「使用其他模型」时作为最终 modelId） */
  const effectiveModelId =
    isCustom || isEdit || values.useOtherModel ? values.modelId.trim() : values.selectedModel;

  const setField = <K extends keyof ModelConfigFormValues>(
    key: K,
    value: ModelConfigFormValues[K],
  ): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors({});
  };

  /** 范围校验：空通过；非空必须落在 [min, max] */
  const inRange = (raw: string, min: number, max: number): boolean => {
    if (raw.trim() === '') return true;
    const num = Number(raw);
    return Number.isFinite(num) && num >= min && num <= max;
  };

  /** 提交前校验（返回错误文案或 null） */
  const validate = (): string | null => {
    if (effectiveModelId === '') {
      return t('settings.modelMgmt.modelIdRequired');
    }
    if (!isEdit && mode === 'provider' && !values.useOtherModel && values.selectedModel === '') {
      return t('settings.modelMgmt.modelRequired');
    }
    if (!inRange(values.temperature, 0, 2)) {
      return t('settings.modelMgmt.temperatureRange');
    }
    if (!inRange(values.topP, 0, 1)) {
      return t('settings.modelMgmt.topPRange');
    }
    if (!inRange(values.topK, 1, 100)) {
      return t('settings.modelMgmt.topKRange');
    }
    return null;
  };

  /** 连通性测试（保存前自动触发；失败阻止提交） */
  const runConnectivityTest = async (): Promise<boolean> => {
    setTesting(true);
    try {
      const res = await testMutation.mutateAsync({
        providerKind: values.providerKind,
        ...(effectiveModelId !== '' ? { modelId: effectiveModelId } : {}),
        // 表单里填了请求地址就传给主进程探测——编辑模式下改地址同样要测新地址
        // （此前 !isEdit 守卫导致编辑模式永远测默认端点，改了地址不生效）
        ...(values.requestUrl.trim() !== '' ? { baseUrl: values.requestUrl.trim() } : {}),
        ...(values.apiKey.trim() !== '' ? { apiKey: values.apiKey.trim() } : {}),
      });
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, test: res.error ?? 'failed' }));
        setTesting(false);
        return false;
      }
      setTesting(false);
      return true;
    } catch (err) {
      // 连通性测试抛错（网络/权限）：视为测试失败，阻止提交
      setErrors((prev) => ({ ...prev, test: err instanceof Error ? err.message : String(err) }));
      setTesting(false);
      return false;
    }
  };

  /** 保存（新增或编辑） */
  const handleSave = async (): Promise<void> => {
    const error = validate();
    if (error !== null) {
      setErrors((prev) => ({ ...prev, modelId: error }));
      return;
    }
    const connected = await runConnectivityTest();
    if (!connected) return;

    const apiKey = values.apiKey.trim() !== '' ? values.apiKey.trim() : undefined;
    const requestUrl = values.requestUrl.trim() !== '' ? values.requestUrl.trim() : undefined;
    const displayName = values.displayName.trim() !== '' ? values.displayName.trim() : undefined;

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({
          modelId: values.modelId.trim(),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(requestUrl !== undefined ? { baseUrl: requestUrl } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
        });
        toast.success(t('settings.modelMgmt.modelUpdated'));
      } else if (isProviderMode) {
        // 服务商模式：API 密钥走提供商级 keychain（settings:setApiKey），
        // 模型添加时省略 apiKey（主进程回退读 keychain 提供商 key）
        if (apiKey !== undefined) {
          await setApiKeyMutation.mutateAsync({
            provider: values.providerKind,
            apiKey,
          });
        }
        await addMutation.mutateAsync({
          modelId: effectiveModelId,
          providerKind: values.providerKind,
          ...(displayName !== undefined ? { displayName } : {}),
        });
        toast.success(t('settings.modelMgmt.modelAdded'));
      } else {
        // 自定义模式：API 密钥走模型级 keychain（addRuntimeModel 的 apiKey 参数）
        await addMutation.mutateAsync({
          modelId: effectiveModelId,
          providerKind: values.providerKind,
          ...(requestUrl !== undefined ? { baseUrl: requestUrl } : {}),
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
        });
        toast.success(t('settings.modelMgmt.modelAdded'));
      }
      onSaved();
    } catch {
      toast.error(t('settings.modelMgmt.saveFailed'));
    }
  };

  const handleReset = (): void => {
    setValues(createDefaultValues());
    setErrors({});
  };

  const title = isEdit
    ? t('settings.modelMgmt.editModelTitle')
    : t('settings.modelMgmt.configModelTitle');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <ModelConfigFields
            mode={mode}
            values={values}
            providerModels={providerModels}
            providerKindLocked={isEdit}
            error={errors.modelId}
            testError={errors.test}
            advancedExpanded={advancedExpanded}
            onToggleAdvanced={() => setAdvancedExpanded((prev) => !prev)}
            onFieldChange={setField}
            onOpenApiKeyUrl={() => {
              const url = providerApiKeyUrl(values.providerKind);
              if (url !== '' && window.api !== undefined) {
                void window.api.app.openExternal({ url });
              }
            }}
          />
        </div>

        <DialogFooter className="flex-row items-center gap-2">
          <p className="text-muted-foreground mr-auto flex items-center gap-1 text-2xs">
            <TriangleAlert className="size-3" strokeWidth={1.5} />
            {t('settings.modelMgmt.connectivityHint')}
          </p>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('settings.modelMgmt.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={testing || addMutation.isPending || updateMutation.isPending}
            onClick={handleReset}
          >
            {t('settings.modelMgmt.reset')}
          </Button>
          <Button
            size="sm"
            disabled={testing || addMutation.isPending || updateMutation.isPending}
            onClick={() => void handleSave()}
          >
            {testing || addMutation.isPending || updateMutation.isPending ? (
              <Loader2 className="mr-1 size-3 animate-spin" strokeWidth={2} />
            ) : null}
            {isEdit ? t('settings.modelMgmt.save') : t('settings.modelMgmt.addModelTitle')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
