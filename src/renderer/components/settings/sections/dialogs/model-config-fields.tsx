// src/renderer/components/settings/sections/dialogs/model-config-fields.tsx
// 模型配置弹窗 · 表单字段区（API 基础配置区 + 高级配置区）
// ──────────────────────────────────────────────────────────────
// 纯展示组件：表单值/错误/联动均由父层 ModelConfigDialog 持有。
// 高级配置区字段首版不持久化（仅表单交互，见文档 3.3.4 字段映射）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider, AvailableModelInfo } from '@code-agent/shared/renderer';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { PROVIDER_LABELS, providerLabel } from '../provider-labels';
import type { ModelConfigMode } from './model-config-dialog';

/** 表单值（数字类字段以字符串承载输入态） */
export interface ModelConfigFormValues {
  readonly providerKind: ApiKeyProvider;
  /** 服务商模式：下拉选中的预设模型 id（'' = 未选） */
  readonly selectedModel: string;
  /** 服务商模式：「使用其他模型」开关 */
  readonly useOtherModel: boolean;
  readonly modelId: string;
  readonly displayName: string;
  /** 自定义/编辑模式：请求地址（映射 baseUrl） */
  readonly requestUrl: string;
  readonly apiKey: string;
  readonly contextInput: string;
  readonly contextOutput: string;
  readonly toolCallRounds: string;
  readonly imageSupport: 'support' | 'unsupport';
  readonly thinkingMode: 'follow' | 'on' | 'off';
  readonly temperature: string;
  readonly topP: string;
  readonly topK: string;
}

export interface ModelConfigFieldsProps {
  readonly mode: ModelConfigMode;
  readonly values: ModelConfigFormValues;
  /** 服务商模式：当前厂商在 models:list 中的可选模型 */
  readonly providerModels: readonly AvailableModelInfo[];
  /** 编辑模式锁定服务商（update 契约不支持改 providerKind） */
  readonly providerKindLocked: boolean;
  /** 校验错误文案（modelId 区域，无错误为 undefined） */
  readonly error: string | undefined;
  /** 连通性测试失败文案（无错误为 undefined） */
  readonly testError: string | undefined;
  readonly advancedExpanded: boolean;
  readonly onToggleAdvanced: () => void;
  readonly onFieldChange: <K extends keyof ModelConfigFormValues>(
    key: K,
    value: ModelConfigFormValues[K],
  ) => void;
  /** 打开当前厂商 API Key 官网 */
  readonly onOpenApiKeyUrl: () => void;
}

/** 上下文窗口 Token 快捷值（截图既定） */
const CONTEXT_INPUT_SHORTCUTS = ['128k', '256k', '512k', '1M'] as const;
const CONTEXT_OUTPUT_SHORTCUTS = ['4k', '16k', '32k', '128k'] as const;

/**
 * 模型配置弹窗表单字段区
 */
export function ModelConfigFields({
  mode,
  values,
  providerModels,
  providerKindLocked,
  error,
  testError,
  advancedExpanded,
  onToggleAdvanced,
  onFieldChange,
  onOpenApiKeyUrl,
}: ModelConfigFieldsProps): ReactElement {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);

  const isProvider = mode === 'provider';
  const isEdit = mode === 'edit';

  const apiFormat = t('settings.modelMgmt.apiFormatOpenAI');
  const inputClass = 'text-xs';
  const labelClass = 'text-2xs text-muted-foreground font-medium';
  const thinkingLabels: Record<string, string> = {
    follow: t('settings.modelMgmt.thinkingFollow'),
    on: t('settings.modelMgmt.thinkingOn'),
    off: t('settings.modelMgmt.thinkingOff'),
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ── API 基础配置区 ─────────────────────────────── */}
      {isProvider && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.providerLabel')} *</Label>
            <Select
              value={values.providerKind}
              disabled={providerKindLocked}
              onValueChange={(v) => {
                // 切换厂商时清空已选模型：旧厂商的 selectedModel 对新厂商无效
                // （否则 effectiveModelId 残留跨厂商模型 id → 保存出错配模型）
                onFieldChange('providerKind', v as ApiKeyProvider);
                onFieldChange('selectedModel', '');
                onFieldChange('useOtherModel', false);
              }}
            >
              <SelectTrigger className={cn('h-8', inputClass)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_LABELS.map((p) => (
                  <SelectItem key={p.kind} value={p.kind} className={inputClass}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.modelLabel')} *</Label>
            <Select
              value={values.useOtherModel ? '__other__' : values.selectedModel}
              onValueChange={(v) => {
                if (v === '__other__') {
                  onFieldChange('useOtherModel', true);
                  onFieldChange('modelId', '');
                } else {
                  onFieldChange('useOtherModel', false);
                  onFieldChange('selectedModel', v);
                }
              }}
            >
              <SelectTrigger className={cn('h-8', inputClass)}>
                <SelectValue placeholder={t('settings.modelMgmt.selectModel')} />
              </SelectTrigger>
              <SelectContent>
                {providerModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className={inputClass}>
                    {m.label}
                  </SelectItem>
                ))}
                <SelectItem value="__other__" className={inputClass}>
                  {t('settings.modelMgmt.useOtherModel')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {!isProvider && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.apiFormatLabel')}</Label>
            <Select value={apiFormat} disabled>
              <SelectTrigger className={cn('h-8', inputClass)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={apiFormat} className={inputClass}>
                  {apiFormat}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.requestUrlLabel')}</Label>
            <Input
              type="text"
              value={values.requestUrl}
              placeholder="https://api.openai.com/v1"
              className={inputClass}
              onChange={(e) => onFieldChange('requestUrl', e.target.value)}
            />
          </div>
        </>
      )}

      {isEdit && (
        <div className="flex flex-col gap-1.5">
          <Label className={labelClass}>{t('settings.modelMgmt.providerLabel')}</Label>
          <Input
            type="text"
            value={providerLabel(values.providerKind)}
            disabled
            className={cn(inputClass, 'opacity-60')}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label className={labelClass}>{t('settings.modelMgmt.modelIdLabel')} *</Label>
        <Input
          type="text"
          value={isProvider && !values.useOtherModel ? values.selectedModel : values.modelId}
          placeholder={t('settings.modelMgmt.modelIdPlaceholder')}
          disabled={isProvider && !values.useOtherModel}
          className={cn(inputClass, isProvider && !values.useOtherModel && 'opacity-60')}
          onChange={(e) => onFieldChange('modelId', e.target.value)}
        />
        {error !== undefined && <p className="text-[var(--error)] text-2xs">{error}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className={labelClass}>{t('settings.modelMgmt.displayNameLabel')}</Label>
        <Input
          type="text"
          value={values.displayName}
          maxLength={32}
          placeholder={t('settings.modelMgmt.displayNamePlaceholder')}
          className={inputClass}
          onChange={(e) => onFieldChange('displayName', e.target.value)}
        />
        <p className="text-muted-foreground text-right text-2xs">{values.displayName.length}/32</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className={labelClass}>{t('settings.modelMgmt.apiKeyLabel')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={values.apiKey}
            placeholder={t('settings.modelMgmt.apiKeyPlaceholder')}
            className={cn(inputClass, 'min-w-0 flex-1')}
            onChange={(e) => onFieldChange('apiKey', e.target.value)}
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors"
            aria-label={showApiKey ? t('settings.hideApiKey') : t('settings.showApiKey')}
            onClick={() => setShowApiKey((prev) => !prev)}
          >
            {showApiKey ? (
              <EyeOff className="size-3.5" strokeWidth={1.5} />
            ) : (
              <Eye className="size-3.5" strokeWidth={1.5} />
            )}
          </button>
        </div>
        <button
          type="button"
          className="text-accent hover:text-accent/80 w-fit cursor-pointer text-2xs underline-offset-2 hover:underline"
          onClick={onOpenApiKeyUrl}
        >
          {t('settings.modelMgmt.getApiKey')}
        </button>
      </div>

      {testError !== undefined && <p className="text-[var(--error)] text-2xs">{testError}</p>}

      {/* ── 高级配置区（折叠） ──────────────────────────── */}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs transition-colors"
        onClick={onToggleAdvanced}
      >
        {advancedExpanded ? (
          <ChevronDown className="size-3.5" strokeWidth={1.5} />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={1.5} />
        )}
        {t('settings.modelMgmt.advancedConfig')}
      </button>

      {advancedExpanded && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.contextInputLabel')}</Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                value={values.contextInput}
                placeholder="872000"
                className={cn(inputClass, 'min-w-0 flex-1')}
                onChange={(e) => onFieldChange('contextInput', e.target.value)}
              />
              {CONTEXT_INPUT_SHORTCUTS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded-full border px-1.5 py-0.5 text-2xs transition-colors"
                  onClick={() => onFieldChange('contextInput', v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.contextOutputLabel')}</Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                value={values.contextOutput}
                placeholder="128000"
                className={cn(inputClass, 'min-w-0 flex-1')}
                onChange={(e) => onFieldChange('contextOutput', e.target.value)}
              />
              {CONTEXT_OUTPUT_SHORTCUTS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded-full border px-1.5 py-0.5 text-2xs transition-colors"
                  onClick={() => onFieldChange('contextOutput', v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.toolCallRoundsLabel')}</Label>
            <Input
              type="text"
              value={values.toolCallRounds}
              placeholder="200"
              className={inputClass}
              onChange={(e) => onFieldChange('toolCallRounds', e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.imageSupportLabel')}</Label>
            <RadioGroup
              value={values.imageSupport}
              className="flex-row gap-4"
              onValueChange={(v) => onFieldChange('imageSupport', v as 'support' | 'unsupport')}
            >
              <div className="flex items-center gap-1.5">
                <RadioGroupItem value="support" id="img-support" />
                <Label htmlFor="img-support" className={cn(inputClass, 'text-foreground')}>
                  {t('settings.modelMgmt.imageSupportYes')}
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <RadioGroupItem value="unsupport" id="img-unsupport" />
                <Label htmlFor="img-unsupport" className={cn(inputClass, 'text-foreground')}>
                  {t('settings.modelMgmt.imageSupportNo')}
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.thinkingModeLabel')}</Label>
            <RadioGroup
              value={values.thinkingMode}
              className="flex-row gap-4"
              onValueChange={(v) => onFieldChange('thinkingMode', v as 'follow' | 'on' | 'off')}
            >
              {(['follow', 'on', 'off'] as const).map((v) => (
                <div key={v} className="flex items-center gap-1.5">
                  <RadioGroupItem value={v} id={`thinking-${v}`} />
                  <Label htmlFor={`thinking-${v}`} className={cn(inputClass, 'text-foreground')}>
                    {thinkingLabels[v]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className={labelClass}>{t('settings.modelMgmt.temperatureLabel')}</Label>
              <Input
                type="text"
                value={values.temperature}
                placeholder={t('settings.modelMgmt.temperaturePlaceholder')}
                disabled={values.thinkingMode === 'off'}
                className={inputClass}
                onChange={(e) => onFieldChange('temperature', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className={labelClass}>{t('settings.modelMgmt.topPLabel')}</Label>
              <Input
                type="text"
                value={values.topP}
                placeholder={t('settings.modelMgmt.topPPlaceholder')}
                disabled={values.thinkingMode === 'off'}
                className={inputClass}
                onChange={(e) => onFieldChange('topP', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className={labelClass}>{t('settings.modelMgmt.topKLabel')}</Label>
              <Input
                type="text"
                value={values.topK}
                placeholder={t('settings.modelMgmt.topKPlaceholder')}
                disabled={values.thinkingMode === 'off'}
                className={inputClass}
                onChange={(e) => onFieldChange('topK', e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
