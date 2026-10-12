import type {
  ApiKeyProvider,
  AvailableModelInfo,
  ModelApiFormat,
} from '@code-agent/shared/renderer';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { type ChangeEvent, type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
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

/** 弹窗模式（定义于底层组件，避免 dialog ↔ fields 循环依赖） */
export type ModelConfigMode = 'provider' | 'custom' | 'edit';

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
  /**
   * API 协议格式（仅自定义模式可选；服务商模式由 providerKind 决定，不显示该字段）
   *
   * 三种取值对应 AI SDK 的三个协议（见 ModelApiFormatSchema 注释）；
   * 默认 openai-chat（兼容面最广，也是本字段引入前的历史行为）。
   */
  readonly apiFormat: ModelApiFormat;
  /** 单回合总时长上限（秒；'' = 不限制；承载输入态，保存时换算毫秒） */
  readonly timeoutSeconds: string;
  readonly contextInput: string;
  readonly contextOutput: string;
  readonly toolCallRounds: string;
  readonly imageSupport: 'support' | 'unsupport';
  readonly thinkingMode: 'follow' | 'on' | 'off';
  readonly temperature: string;
  readonly topP: string;
  readonly topK: string;
}

/** 模型配置表单字段组 props（受控表单：值/错误/高级段展开均由父层持有） */
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

/** schema 上限（packages/shared settings.ts 的 10_000_000 护栏，保存侧同口径拦截） */
export const CONTEXT_TOKENS_MAX = 10_000_000;

/**
 * tokens → 厂商标称 K/M 显示（二进制/十进制自适应）
 *
 * 显示口径：厂商标称混用二进制（131072→128k）与十进制（384000→384k）。
 * Ki 档位判据 = 能被 1024 整除**且商为 2 的幂**——128/256/512…是厂商惯用的二进制档位，
 * 而 384000 = 375×1024 虽整除但商非 2 幂，是十进制 384K 的巧合整除，不能按 Ki 显示；
 * 否则能被 1000 整除按十进制 K；否则四舍五入取近似。
 * 与 parseTokenLabel 构成换算对——parse 侧 'k' 恒按 ×1024（二进制 K 是 Token 计数惯例），
 * 故十进制标称值经「预填→保存」会二进制化（384000→393216，+2.4% 漂移，方向保守：
 * 仅影响压缩预算/输出钳制，不损数据）。末尾回环自校验兜底超限死角：
 * 10000000 → "10000k" 解析超上限会卡保存校验 → 回退纯 Token 数（parse 恒精确）。
 */
export function formatTokenLabel(tokens: number): string {
  if (tokens % (1024 * 1024) === 0 && tokens >= 1024 * 1024) {
    return `${tokens / (1024 * 1024)}M`;
  }
  const quotient = tokens / 1024;
  if (Number.isInteger(quotient) && isPowerOfTwo(quotient)) {
    return `${quotient}k`;
  }
  const candidate = tokens % 1000 === 0 ? `${tokens / 1000}k` : `${Math.round(tokens / 1000)}k`;
  return parseTokenLabel(candidate) !== undefined ? candidate : `${tokens}`;
}

/** 判 2 的幂（Ki 档位商识别：正整数且二进制仅一位为 1） */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * K/M 快捷值或纯 Token 数 → tokens（表单值解析回传持久化）
 *
 * 纯数字按原始 tokens；k/K 按 ×1024（二进制 K 是 Token 计数惯例）；
 * m/M 按 ×1024²。非法（非数字/非正数/超 schema 上限）返回 undefined。
 */
export function parseTokenLabel(raw: string): number | undefined {
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  const match = value.match(/^(\d+)([kKmM]?)$/);
  if (match === null) {
    return undefined;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) {
    return undefined;
  }
  const suffix = match[2]?.toLowerCase() ?? '';
  const tokens = suffix === 'k' ? base * 1024 : suffix === 'm' ? base * 1024 * 1024 : base;
  return tokens <= CONTEXT_TOKENS_MAX ? tokens : undefined;
}

/** 字段级样式常量（多处复用，收敛字面量） */
const FIELD_INPUT_CLASS = 'text-xs';
const FIELD_LABEL_CLASS = 'text-2xs text-muted-foreground font-medium';

/**
 * API 密钥输入（含显隐切换 + 官网申请链接）
 *
 * 抽离动机（2026-09 审计）：这是 ModelConfigFields 里唯一需要组件内 state
 * （showApiKey）的字段，其 3 个三元（input type / aria-label / 图标）此前
 * 全部计入父函数复杂度（父函数 cx 16，阈值 15）。独立后状态就近，父函数回归直线。
 */
function ApiKeyField({
  value,
  onChange,
  onOpenApiKeyUrl,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onOpenApiKeyUrl: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const forwardInput = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(event.currentTarget.value);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label className={FIELD_LABEL_CLASS}>{t('settings.modelMgmt.apiKeyLabel')}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type={showApiKey ? 'text' : 'password'}
          value={value}
          placeholder={t('settings.modelMgmt.apiKeyPlaceholder')}
          className={cn(FIELD_INPUT_CLASS, 'min-w-0 flex-1')}
          onChange={forwardInput}
        />
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0 border"
          aria-label={showApiKey ? t('settings.hideApiKey') : t('settings.showApiKey')}
          onClick={() => setShowApiKey((prev) => !prev)}
        >
          {showApiKey ? (
            <EyeOff className="size-3.5" strokeWidth={1.5} />
          ) : (
            <Eye className="size-3.5" strokeWidth={1.5} />
          )}
        </Button>
      </div>
      <Button
        variant="link"
        size="sm"
        className="text-accent hover:text-accent/80 h-auto w-fit p-0 text-2xs underline-offset-2"
        onClick={onOpenApiKeyUrl}
      >
        {t('settings.modelMgmt.getApiKey')}
      </Button>
    </div>
  );
}

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

  const isProvider = mode === 'provider';
  const isEdit = mode === 'edit';
  /** modelId 锁定：编辑模式（update 主键）或服务商下拉已选定 */
  const modelIdLocked = isEdit || (isProvider && !values.useOtherModel);

  /** 选中预设模型时用厂商适配的官方数值预填高级配置（仅填空字段——用户手改过的不覆盖）。
   * ⚠ 显示口径：厂商标称混用二进制（131072→128k）与十进制（384000→384k），换算走
   * formatTokenLabel 自适应；持久化方向由 dialog 的 parseTokenLabel 解析回传 */
  const applyPresetCapabilities = (modelId: string): void => {
    const preset = providerModels.find((m) => m.id === modelId);
    const caps = preset?.capabilities as
      | { contextWindowSize?: number; maxOutputTokens?: number; vision?: boolean }
      | undefined;
    if (caps === undefined) {
      return;
    }
    if (values.contextInput.trim() === '' && caps.contextWindowSize !== undefined) {
      onFieldChange('contextInput', formatTokenLabel(caps.contextWindowSize));
    }
    if (values.contextOutput.trim() === '' && caps.maxOutputTokens !== undefined) {
      onFieldChange('contextOutput', formatTokenLabel(caps.maxOutputTokens));
    }
    // 视觉：capabilities.vision（仅自动填「支持」——无视觉标注的模型不主动改用户选择）
    if (caps.vision === true && values.imageSupport === 'unsupport') {
      onFieldChange('imageSupport', 'support');
    }
  };

  const inputClass = 'text-xs';
  const labelClass = 'text-2xs text-muted-foreground font-medium';
  const thinkingLabels: Record<string, string> = {
    follow: t('settings.modelMgmt.thinkingFollow'),
    on: t('settings.modelMgmt.thinkingOn'),
    off: t('settings.modelMgmt.thinkingOff'),
  };

  return (
    <div className="flex flex-col gap-3">
      {isProvider && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className={labelClass}>{t('settings.modelMgmt.providerLabel')} *</Label>
            <Select
              value={values.providerKind}
              disabled={providerKindLocked}
              onValueChange={(v) => {
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
                    {providerLabel(p.kind, t)}
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
                  // 选中预设模型：capabilities 自动预填高级配置（厂商适配的官方数值）
                  applyPresetCapabilities(v);
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
            <Select
              value={values.apiFormat}
              onValueChange={(v) => onFieldChange('apiFormat', v as ModelApiFormat)}
            >
              <SelectTrigger className={cn('h-8', inputClass)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-chat" className={inputClass}>
                  {t('settings.modelMgmt.apiFormat_openai-chat')}
                </SelectItem>
                <SelectItem value="openai-responses" className={inputClass}>
                  {t('settings.modelMgmt.apiFormat_openai-responses')}
                </SelectItem>
                <SelectItem value="anthropic-messages" className={inputClass}>
                  {t('settings.modelMgmt.apiFormat_anthropic-messages')}
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
            value={providerLabel(values.providerKind, t)}
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
          disabled={modelIdLocked}
          className={cn(inputClass, modelIdLocked && 'opacity-60')}
          onChange={(e) => onFieldChange('modelId', e.target.value)}
        />
        {error !== undefined && <p className="text-error-text text-2xs">{error}</p>}
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
        <Label className={labelClass}>{t('settings.modelMgmt.timeoutLabel')}</Label>
        <Input
          type="text"
          inputMode="numeric"
          value={values.timeoutSeconds}
          placeholder={t('settings.modelMgmt.timeoutPlaceholder')}
          className={inputClass}
          onChange={(e) => onFieldChange('timeoutSeconds', e.target.value)}
        />
      </div>

      <ApiKeyField
        value={values.apiKey}
        onChange={(v) => onFieldChange('apiKey', v)}
        onOpenApiKeyUrl={onOpenApiKeyUrl}
      />

      {testError !== undefined && <p className="text-error-text text-2xs">{testError}</p>}

      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-auto w-fit px-0 text-xs"
        onClick={onToggleAdvanced}
      >
        {advancedExpanded ? (
          <ChevronDown className="size-3.5" strokeWidth={1.5} />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={1.5} />
        )}
        {t('settings.modelMgmt.advancedConfig')}
      </Button>

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
                <Button
                  key={v}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground h-auto shrink-0 rounded-full border px-1.5 py-0.5 text-2xs"
                  onClick={() => onFieldChange('contextInput', v)}
                >
                  {v}
                </Button>
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
                <Button
                  key={v}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground h-auto shrink-0 rounded-full border px-1.5 py-0.5 text-2xs"
                  onClick={() => onFieldChange('contextOutput', v)}
                >
                  {v}
                </Button>
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
