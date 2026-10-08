// src/renderer/components/settings/sections/dialogs/model-config-dialog.tsx
// 模型配置弹窗（统一表单 · 服务商/自定义/编辑三模式）
// ──────────────────────────────────────────────────────────────
// 保存流程（文档 3.3.3 已定）：校验 → 连通性测试（失败阻止提交并标红）
// → add/update → 失效 RUNTIME_MODELS_QUERY_KEY + MODELS_QUERY_KEY。
// 高级配置区字段首版不持久化（文档 3.3.4 字段映射），仅表单交互。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, RuntimeModelInfo } from '@code-agent/shared/renderer';
import { Loader2, TriangleAlert } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
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
import { openExternal } from '@/lib/app-actions';
import { providerApiKeyUrl } from '../provider-labels';
import {
  ModelConfigFields,
  type ModelConfigFormValues,
  type ModelConfigMode,
} from './model-config-fields';

/** 模型配置弹窗 props（新增/编辑双模式，mode 与 editingModel 联动见字段注释） */
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
    // 默认 Chat Completions：兼容面最广，也是本字段引入前的历史行为
    apiFormat: 'openai-chat',
    timeoutSeconds: '',
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
 * 表单可选项 → mutation payload 片段（空串视为「未提供」）
 *
 * exactOptionalPropertyTypes 下不能直接传 `undefined`，故统一条件展开。
 * 集中一处后各保存分支只做 `...fields.displayName` 这类展开，不再重复写三元。
 * `apiKeyValue` 单独给出原始值（服务商模式需先单独调 setApiKey mutation）。
 */
function trimOptionalFields(values: ModelConfigFormValues): {
  readonly displayName: Record<string, string>;
  readonly requestUrl: Record<string, string>;
  readonly apiKey: Record<string, string>;
  readonly apiKeyValue: string | undefined;
  /**
   * 超时（毫秒）：'' → null（编辑分支据此发送 null 清除，回不限制）；
   * 秒 → 毫秒换算取整（1.5s → 1500ms）
   */
  readonly timeoutMs: number | null;
} {
  const displayName = values.displayName.trim();
  const requestUrl = values.requestUrl.trim();
  const apiKey = values.apiKey.trim();
  const timeoutRaw = values.timeoutSeconds.trim();
  return {
    displayName: displayName !== '' ? { displayName } : {},
    // update / add 契约里请求地址字段名是 baseUrl
    requestUrl: requestUrl !== '' ? { baseUrl: requestUrl } : {},
    apiKey: apiKey !== '' ? { apiKey } : {},
    apiKeyValue: apiKey !== '' ? apiKey : undefined,
    timeoutMs: timeoutRaw !== '' ? Math.round(Number(timeoutRaw) * 1000) : null,
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
        // 记录值回填；未设置（存量行）→ 默认 openai-chat（与历史行为一致）
        apiFormat: editingModel.apiFormat ?? 'openai-chat',
        // 毫秒 → 秒回显（1500 → '1.5'）；未设置 → 空串（= 不限制）
        timeoutSeconds:
          editingModel.timeoutMs !== undefined ? String(editingModel.timeoutMs / 1000) : '',
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

  /** 当前厂商的内置模型全集（服务商模式下拉；listBuiltin 已按厂商过滤）；纯派生交给 Compiler */
  const providerModels = isCustom || isEdit ? [] : (builtinData?.models ?? []);

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
    if (!inRange(values.timeoutSeconds, 1, 86_400)) {
      return t('settings.modelMgmt.timeoutRange');
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
        // 自定义模式带上所选格式：探测须按该格式的协议路径与请求体发起，
        // 否则会「按 Chat Completions 测 Responses/Anthropic 端点」而假红
        ...(isCustom ? { apiFormat: values.apiFormat } : {}),
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

  /**
   * 保存（新增或编辑）
   *
   * 分支只负责「调哪个 mutation + 提示什么」（三模式 payload 构造经
   * trimOptionalFields 预组装；dispatch 拆为 saveByMode，使 handleSave 仅剩
   * 校验→测试→执行→提示的直线流程——此前分支内联展开曾把认知复杂度推到 40）。
   */
  const handleSave = async (): Promise<void> => {
    const error = validate();
    if (error !== null) {
      setErrors((prev) => ({ ...prev, modelId: error }));
      return;
    }
    if (!(await runConnectivityTest())) return;
    try {
      await saveByMode();
      onSaved();
    } catch {
      toast.error(t('settings.modelMgmt.saveFailed'));
    }
  };

  /** 按模式分发保存：服务商模式密钥走厂商级 keychain，其余走模型级 */
  const saveByMode = async (): Promise<void> => {
    const fields = trimOptionalFields(values);
    if (isEdit) {
      await updateMutation.mutateAsync({
        modelId: values.modelId.trim(),
        ...fields.displayName,
        ...fields.requestUrl,
        ...fields.apiKey,
        // '' → null：编辑弹窗清空超时即发送清除语义（回不限制）
        timeoutMs: fields.timeoutMs,
        apiFormat: values.apiFormat,
      });
      toast.success(t('settings.modelMgmt.modelUpdated'));
      return;
    }
    if (isProviderMode) {
      // 服务商模式：API 密钥走提供商级 keychain（settings:setApiKey），
      // 模型添加时省略 apiKey（主进程回退读 keychain 提供商 key）。
      // 也不传 apiFormat——服务商模式的格式由 providerKind 决定（主进程按
      // 默认格式路由），显式传会把「按 kind 决定」变成「按用户表单值决定」
      if (fields.apiKeyValue !== undefined) {
        await setApiKeyMutation.mutateAsync({
          provider: values.providerKind,
          apiKey: fields.apiKeyValue,
        });
      }
      await addMutation.mutateAsync({
        modelId: effectiveModelId,
        providerKind: values.providerKind,
        ...fields.displayName,
        timeoutMs: fields.timeoutMs,
      });
      toast.success(t('settings.modelMgmt.modelAdded'));
      return;
    }
    // 自定义模式：API 密钥走模型级 keychain（addRuntimeModel 的 apiKey 参数）
    await addMutation.mutateAsync({
      modelId: effectiveModelId,
      providerKind: values.providerKind,
      ...fields.requestUrl,
      ...fields.apiKey,
      ...fields.displayName,
      timeoutMs: fields.timeoutMs,
      apiFormat: values.apiFormat,
    });
    toast.success(t('settings.modelMgmt.modelAdded'));
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
              if (url !== '') {
                openExternal(url).catch(() => {
                  // 打开失败静默：非关键路径
                });
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
