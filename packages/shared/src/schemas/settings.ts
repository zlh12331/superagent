// packages/shared/src/schemas/settings.ts
// Settings 域 zod schema 单一真源（用户设置 / 敏感数据管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 Settings 域 zod schema，作为 IPC 入参运行时校验的单一真源
// - 当前仅提供 API Key 管理（getSecret / setSecret / deleteSecret）
//   敏感数据通过主进程 safeStorage 加密存储，渲染层只读写明文
//
// 设计：
// - provider 字段标识 API 提供商（如 'deepseek'），作为 keychain 的 key
// - apiKey 明文由渲染层传入，主进程加密后存储
// - getApiKeyRes 返回 string | null（未设置时为 null，不返回 undefined 避免 IPC 序列化问题）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * API Key 提供商标识
 *
 * 用作 keychain 的 key 前缀（如 'deepseek' → 'deepseek-api-key'）。
 * 与主进程 ProviderRegistry（src/main/infra/ai/providers）保持一致：
 * - deepseek：DeepSeek 官方 API（OpenAI Compatible）
 * - openai：OpenAI 官方 API
 * - anthropic：Anthropic Claude API
 * - ollama：本地 Ollama 服务（无需 API Key，保留枚举项供 UI 展示）
 */
export const ApiKeyProviderSchema = z.enum([
  'deepseek',
  'openai',
  'anthropic',
  'ollama',
  'moonshot',
  'zhipu',
  'qwen',
  'doubao',
  'siliconflow',
  'openrouter',
]);

/** API Key 提供商标识 TypeScript 类型 */
export type ApiKeyProvider = z.infer<typeof ApiKeyProviderSchema>;

/**
 * settings:getApiKey 请求 payload
 *
 * 渲染层查询指定提供商的 API Key，主进程从 keychain 读取并解密返回。
 */
export const GetApiKeyReqSchema = z.object({
  /** API 提供商标识（如 'deepseek'） */
  provider: ApiKeyProviderSchema,
});

/**
 * settings:getApiKey 响应 payload
 *
 * P0 安全修复：不再向渲染层回传明文 API Key。
 * 渲染层唯一合法的用途是判断"是否已配置"，明文只存在于主进程 keychain，
 * 经 setApiKey 写入、由主进程内部消费（llmClient）。
 */
export interface GetApiKeyRes {
  /** 是否已配置（true = keychain 中存在该 provider 的 Key） */
  readonly configured: boolean;
}

/** settings:getApiKey 响应 zod schema（R3：响应契约校验） */
export const GetApiKeyResSchema = z.object({
  configured: z.boolean(),
});

// ── 渲染层设置下沉 SQLite（settings 持久化单一真源） ─────────────

/** settings:getAll 入参（无入参） */
export const SettingsGetAllReqSchema = z.object({});

/** settings:getAll 响应（key → JSON 值；渲染层设置按域分 key 存储） */
export const SettingsGetAllResSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

/**
 * settings:set 可写键白名单（P0 收口）
 *
 * 渲染层 settings-store 的全部持久化分组（persistSetting 的 key 实参集合）。
 * 白名单外的一律拒绝——此前 key 为自由字符串，渲染层可覆写主进程消费的
 * 任意 app_settings 键（如未来新增的 trusted 配置组），且持久化后重启仍生效。
 *
 * 注意：'lsp' 是合法 UI 功能（用户按语言覆盖语言服务器命令），值级约束
 * 见 SettingsSetReqSchema 的 superRefine。
 */
export const SETTING_KEYS = [
  'theme',
  'language',
  'ai',
  'editor',
  'shortcuts',
  'experimental',
  'lsp',
  'workspace',
  'browser',
  // 自动更新开关（settings.update.autoCheck；默认开，缺失/损坏视为开）
  'update',
  // 关窗行为（settings.window.closeAction；默认 minimize=最小化到托盘，见 28-tray-spec）
  'window',
  // 记忆功能开关（settings.memory.enabled；关闭后不捕获新记忆、不注入召回）
  'memory',
  // IM 群聊白名单（im-allowlist-field 直写，非 settings-store 分组）
  'im.allowedGroups',
] as const;

/** settings:set 可写键白名单 TypeScript 类型 */
export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * LSP 服务器命令行门禁（lsp.serverCommands 值级约束）
 *
 * UI 契约（设置页文案）是"需对应服务器已在 PATH 中安装"——首 token 必须是
 * 裸可执行名（无路径分隔符/空白），拒绝 `/usr/bin/xxx`、`C:\...\xxx.exe`
 * 等任意路径形态与 `ext::` 类传输串。剩余 token 是语言服务器参数
 *（spawn 数组语义，不经 shell），属功能本身。
 */
export function isSafeLsServerCommand(commandLine: string): boolean {
  const firstToken = commandLine.trim().split(/\s+/)[0];
  if (firstToken === undefined || firstToken === '') {
    return false;
  }
  return /^[A-Za-z0-9._-]+$/.test(firstToken);
}

/** settings:set 入参（写穿透：渲染层内存态变更后同步落库） */
export const SettingsSetReqSchema = z
  .object({
    key: z.enum(SETTING_KEYS),
    value: z.unknown(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.key !== 'lsp') {
      return;
    }
    const commands = (cfg.value as { serverCommands?: unknown } | null | undefined)?.serverCommands;
    if (commands === undefined || commands === null || typeof commands !== 'object') {
      return;
    }
    const invalid = Object.entries(commands as Record<string, unknown>)
      .filter(([, cmd]) => typeof cmd !== 'string' || !isSafeLsServerCommand(cmd))
      .map(([lang]) => lang);
    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `lsp.serverCommands 仅支持 PATH 中的裸可执行名，非法语言键：${invalid.join(', ')}`,
      });
    }
  });

/** settings:set 响应 */
export const SettingsSetResSchema = z.object({
  ok: z.boolean(),
});

/**
 * settings:setApiKey 请求 payload
 *
 * 渲染层传入明文 API Key，主进程加密后存储到 keychain。
 */
export const SetApiKeyReqSchema = z.object({
  /** API 提供商标识 */
  provider: ApiKeyProviderSchema,
  /** API Key 明文（主进程加密后存储） */
  apiKey: z.string().min(1),
});

/** settings:setApiKey 响应 payload */
export interface SetApiKeyRes {
  /** 是否成功写入 */
  readonly ok: boolean;
}

/** settings:setApiKey 响应 zod schema（R3：响应契约校验） */
export const SetApiKeyResSchema = z.object({
  ok: z.boolean(),
});

/**
 * settings:deleteApiKey 请求 payload
 *
 * 删除指定提供商的 API Key。
 */
export const DeleteApiKeyReqSchema = z.object({
  provider: ApiKeyProviderSchema,
});

/** settings:deleteApiKey 响应 payload */
export interface DeleteApiKeyRes {
  /** 是否成功删除（未设置时也返回 true） */
  readonly ok: boolean;
}

/** settings:deleteApiKey 响应 zod schema（R3：响应契约校验） */
export const DeleteApiKeyResSchema = z.object({
  ok: z.boolean(),
});

// ─── Telemetry 用户开关（隐私合规） ─────────────────────────────

/**
 * 遥测级别（对标 VS Code telemetry.telemetryLevel / Cursor 双开关）
 *
 * - off：完全不初始化 Sentry，不上报任何错误和性能数据
 * - error-only：仅上报错误（tracesSampleRate = 0），不上报性能事务
 * - full：上报错误 + 性能事务（受 tracesSampleRate 采样率控制）
 */
export const TelemetryLevelSchema = z.enum(['off', 'error-only', 'full']);

/** 遥测级别 TypeScript 类型 */
export type TelemetryLevel = z.infer<typeof TelemetryLevelSchema>;

/**
 * settings:getTelemetryLevel 响应 payload
 */
export interface GetTelemetryLevelRes {
  /** 当前遥测级别 */
  readonly level: TelemetryLevel;
}

/** settings:getTelemetryLevel 响应 zod schema（响应契约校验用） */
export const GetTelemetryLevelResSchema = z.object({
  level: TelemetryLevelSchema,
});

/**
 * settings:setTelemetryLevel 请求 payload
 */
export const SetTelemetryLevelReqSchema = z.object({
  /** 目标遥测级别 */
  level: TelemetryLevelSchema,
});

/** settings:setTelemetryLevel 响应 payload */
export interface SetTelemetryLevelRes {
  /** 是否成功写入 */
  readonly ok: boolean;
  /** 写入后的级别（用于 UI 回显确认） */
  readonly level: TelemetryLevel;
}

/** settings:setTelemetryLevel 响应 zod schema（响应契约校验用） */
export const SetTelemetryLevelResSchema = z.object({
  ok: z.boolean(),
  level: TelemetryLevelSchema,
});

/**
 * settings:addRuntimeModel 入参 zod schema（自定义模型）
 */
export const AddRuntimeModelReqSchema = z.object({
  // 模型 id（全局唯一，如 custom-coder）
  modelId: z.string().min(1).max(100),
  // 所属供应商 kind（决定 SDK 协议）
  providerKind: ApiKeyProviderSchema,
  // 显式 baseUrl（覆盖供应商默认端点；可选）
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 API Key（可选；省略则走 keychain 默认 key）
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  // 展示名称（可选；省略 = 回退 modelId）
  displayName: z
    .string()
    .max(32)
    .optional()
    .transform((v) => v ?? undefined),
  // 启停状态（可选；省略 = 启用）
  isEnabled: z.boolean().optional(),
});

/** settings:addRuntimeModel 响应 payload */
export interface AddRuntimeModelRes {
  readonly ok: boolean;
}

/** settings:addRuntimeModel 响应 zod schema（R4：响应契约校验） */
export const AddRuntimeModelResSchema = z.object({
  ok: z.boolean(),
});

/** settings:removeRuntimeModel 入参 zod schema */
export const RemoveRuntimeModelReqSchema = z.object({
  modelId: z.string().min(1).max(100),
});

/** settings:removeRuntimeModel 响应 payload */
export interface RemoveRuntimeModelRes {
  readonly ok: boolean;
}

/** settings:removeRuntimeModel 响应 zod schema（R4：响应契约校验） */
export const RemoveRuntimeModelResSchema = z.object({
  ok: z.boolean(),
});

/**
 * settings:updateRuntimeModel 入参 zod schema（编辑 + 启停）
 *
 * 省略字段不修改（partial 语义）；apiKey 传入时更新 keychain。
 */
export const UpdateRuntimeModelReqSchema = z.object({
  modelId: z.string().min(1).max(100),
  // 展示名称（可选；null/undefined = 不修改）
  displayName: z
    .string()
    .max(32)
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 baseUrl（可选；不传 = 不修改）
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 API Key（可选；不传 = 不修改，传入则更新 keychain）
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  // 启停状态（可选；不传 = 不修改）
  isEnabled: z.boolean().optional(),
});

/** settings:updateRuntimeModel 响应 payload */
export interface UpdateRuntimeModelRes {
  readonly ok: boolean;
}

/** settings:updateRuntimeModel 响应 zod schema（R4：响应契约校验） */
export const UpdateRuntimeModelResSchema = z.object({
  ok: z.boolean(),
});

/** 运行时模型列表条目（settings:listRuntimeModels 响应） */
export interface RuntimeModelInfo {
  readonly modelId: string;
  readonly providerKind: ApiKeyProvider;
  readonly baseUrl: string | undefined;
  readonly displayName: string | undefined;
  readonly isEnabled: boolean;
  readonly createdAt: number;
}

/** settings:listRuntimeModels 响应 payload */
export interface ListRuntimeModelsRes {
  readonly models: readonly RuntimeModelInfo[];
}

/** settings:listRuntimeModels 响应 zod schema（R4：响应契约校验） */
export const ListRuntimeModelsResSchema = z.object({
  models: z.array(
    z.object({
      modelId: z.string(),
      providerKind: ApiKeyProviderSchema,
      baseUrl: z
        .string()
        .optional()
        .transform((v) => v ?? undefined),
      displayName: z
        .string()
        .optional()
        .transform((v) => v ?? undefined),
      isEnabled: z.boolean(),
      createdAt: z.number().int(),
    }),
  ),
});

/**
 * 工具审批模式（对齐 qwen ApprovalMode 谱系，配置化替代写死两级）
 *
 * - plan：只读探索，写工具直接拒绝（Plan/Apply 分离的只读阶段）
 * - ask：写工具均需用户审批（保守默认）
 * - auto：工作区编辑自动放行，危险命令（exec 类）仍审批
 * - yolo：全部自动放行（仅信任环境使用）
 */
export const ApprovalModeSchema = z.enum(['plan', 'ask', 'auto', 'yolo']);

/** 工具审批模式 TypeScript 类型 */
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** 默认审批模式（保守：写操作均需审批；主进程偏好文件与权限服务共用） */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask';

/** settings:getApprovalMode 响应 payload */
export interface GetApprovalModeRes {
  readonly mode: ApprovalMode;
}

/** settings:getApprovalMode 响应 zod schema（响应契约校验用） */
export const GetApprovalModeResSchema = z.object({
  mode: ApprovalModeSchema,
});

/** settings:setApprovalMode 入参 zod schema */
export const SetApprovalModeReqSchema = z.object({
  mode: ApprovalModeSchema,
});

/** settings:setApprovalMode 响应 payload */
export interface SetApprovalModeRes {
  readonly ok: boolean;
  /** 写入后的模式（用于 UI 回显确认） */
  readonly mode: ApprovalMode;
}

/** settings:setApprovalMode 响应 zod schema（R4：响应契约校验） */
export const SetApprovalModeResSchema = z.object({
  ok: z.boolean(),
  mode: ApprovalModeSchema,
});
