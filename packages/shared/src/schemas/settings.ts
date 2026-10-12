// settings.ts：Settings 域 IPC 契约（zod 入参/响应 schema + 类型）的单一真源——API Key 管理、设置持久化键
// 白名单、遥测/审批模式、运行时自定义模型、设置导出导入
// 边界：只定义形状与值域；落库（app_settings）/凭据（keychain）/代理、缩放等主进程应用点都在各自模块

import { z } from 'zod';

import { EDITOR_TAB_SIZES } from '../constants/editor';
import { TERMINAL_FONT_SIZES, TERMINAL_SHELL_CHOICES } from '../constants/terminal-shell';
import { ZOOM_LEVELS } from '../constants/zoom';

/**
 * 自定义模型的 API 协议格式（三选一）
 *
 * 三方语义（与 AI SDK 的接口一一对应）：
 * - `openai-chat`：OpenAI Chat Completions（`POST {base}/chat/completions`）
 *   —— 兼容面最广，绝大多数第三方网关 / 自建推理服务用这个
 * - `openai-responses`：OpenAI Responses API（`POST {base}/responses`）
 *   —— 新版协议，支持内置工具与更强推理；仅 OpenAI 官方及少数网关提供
 * - `anthropic-messages`：Anthropic Messages（`POST {base}/messages`）
 *   —— Claude 原生协议
 *
 * 仅用于「自定义模式」（手动填请求地址）的模型；服务商模式的格式由
 * providerKind 决定，不暴露本字段。
 *
 * ⚠️ 存储默认值为 `openai-chat`：自定义模型历史上一律按 Chat Completions
 * 调用，迁移存量行（apiFormat 为 NULL）时不得改变既有模型的调用协议。
 */
export const ModelApiFormatSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
]);

/** 自定义模型的 API 协议格式 */
export type ModelApiFormat = z.infer<typeof ModelApiFormatSchema>;

/** 全部 API 格式（顺序 = 展示顺序；主进程读侧校验 DB 脏值时按此表判定成员资格） */
export const MODEL_API_FORMATS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
] as const satisfies readonly ModelApiFormat[];

/**
 * API Key 提供商标识（10 家）
 *
 * 用作 keychain 的 key 前缀（如 'deepseek' → 'deepseek-api-key'，拼法真源为
 * 主进程 toKeychainKey）。与主进程 ProviderRegistry（src/main/infra/ai/providers）保持一致：
 * - deepseek / moonshot / zhipu / qwen / doubao / siliconflow / openrouter：OpenAI Compatible 协议
 * - openai：OpenAI 官方 API
 * - anthropic：Anthropic Claude API（Messages 协议）
 * - ollama：本地 Ollama 服务（无需 API Key，保留枚举项供 UI 展示）
 *
 * 扩展新供应商：主进程 PROVIDER_KINDS 与 BUILTIN_DEFINITIONS / BUILTIN_FACTORIES
 * 同步各加一条，本枚举随之扩展。
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
  'mimo',
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
 * 不回传明文 API Key：渲染层唯一合法的用途是判断"是否已配置"，明文只存在于
 * 主进程 keychain，经 setApiKey 写入、由主进程内部消费（llmClient）。
 */
export interface GetApiKeyRes {
  /** 是否已配置（true = keychain 中存在该 provider 的 Key） */
  readonly configured: boolean;
  /** 系统加密（safeStorage）是否可用——false 时 configured 恒为 false，
   * 「密钥不可读」与「未配置」在调用方视角必须可区分 */
  readonly keychainAvailable: boolean;
}

/** settings:getApiKey 响应 zod schema（R3：响应契约校验） */
export const GetApiKeyResSchema = z.object({
  configured: z.boolean(),
  keychainAvailable: z.boolean(),
});

// ── 渲染层设置下沉 SQLite（settings 持久化单一真源） ─────────────

/** settings:getAll 入参（无入参） */
export const SettingsGetAllReqSchema = z.object({});

/** settings:getAll 响应（key → JSON 值；渲染层设置按域分 key 存储） */
export const SettingsGetAllResSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

/** settings:resetAll 入参（无入参） */
export const SettingsResetAllReqSchema = z.object({});

/**
 * settings:resetAll 响应
 *
 * settings 恒为空对象：重置的实现语义是「删除 SETTING_KEYS 全部键」——
 * app_settings 回到新用户空表状态，缺失即默认（渲染层 applySettingsSnapshot({})
 * 全量回落 DEFAULT_SETTINGS；主进程各 readSetting 消费方均有 undefined→默认兜底）。
 * 不影响：keychain 凭据、会话历史、MCP/IM 渠道配置、OS 登录项（开机自启）。
 */
export interface SettingsResetAllRes {
  readonly settings: Record<string, unknown>;
}

/** settings:resetAll 响应 zod schema（响应契约校验用） */
export const SettingsResetAllResSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

/**
 * settings:set 可写键白名单
 *
 * 渲染层 settings-store 的全部持久化分组（persistSetting 的 key 实参集合）。
 * 白名单外的一律拒绝——若 key 为自由字符串，渲染层可覆写主进程消费的任意
 * app_settings 键（如主进程内部配置组），且持久化后重启仍生效。
 * 本表同时是 settings:resetAll 的删除范围与设置导入的写入白名单。
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
  // 自动更新开关（settings.update：autoCheck 默认开、allowPrerelease 默认关；缺失/损坏按默认）
  'update',
  // 关窗行为（settings.window.closeAction；默认 minimize=最小化到托盘，见 docs/implementation/28-tray-spec.md）
  'window',
  // 记忆功能开关（settings.memory.enabled；关闭后不捕获新记忆、不注入召回）
  'memory',
  // 系统通知（settings.notification：回合结束后台提醒的门控开关组，
  // 主进程 notification.ts 发送前即时读取；缺失/损坏视为全开）
  'notification',
  // 网络代理（settings.proxy：{mode, url?, bypass?}；主进程 proxy-applier 四路径
  // 收口应用——启动/settings:set/import/resetAll；缺失/损坏视为 system 直通）
  'proxy',
  // 界面缩放（settings.appearance：{zoom}；主进程 window:applyZoom 应用
  // webContents.setZoomFactor + Windows overlay 联动；缺失视为 1，损坏归最近档位）
  'appearance',
  // 终端（settings.terminal：{shell, fontSize}；主进程 TerminalService spawn 时
  // 即时读并解析默认 shell——渲染层不传 shell（terminal:create P0 收口不变）；
  // 缺失视为 {shell:'auto', fontSize:13}，损坏逐字段回落）
  'terminal',
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
  })
  .superRefine((cfg, ctx) => {
    // proxy 值级门禁：fixed 模式下 url 必须是合法 http(s) URL。本 schema 只覆盖
    // settings:set 通道；导入路径（applySettingsImport 白名单直写）不过本 schema，
    // 那里靠 resolver 的 fail-open 兜底——双防线，写拒在前保证无半生效状态。
    if (cfg.key !== 'proxy') {
      return;
    }
    const value = cfg.value as { mode?: unknown; url?: unknown } | null | undefined;
    if (value === null || value === undefined || typeof value !== 'object') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'proxy 配置必须是非空对象（{mode, url?, bypass?}）',
      });
      return;
    }
    const validModes = ['system', 'direct', 'fixed'];
    if (!validModes.includes(value.mode as string)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `proxy.mode 仅支持 ${validModes.join('/')}`,
      });
      return;
    }
    if (value.mode === 'fixed') {
      let urlOk = false;
      if (typeof value.url === 'string' && value.url.length > 0) {
        try {
          const parsed = new URL(value.url);
          urlOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          urlOk = false;
        }
      }
      if (!urlOk) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message:
            'proxy.mode=fixed 时 url 必须是合法 http(s) 代理地址（如 http://127.0.0.1:7890）',
        });
      }
    }
  })
  .superRefine((cfg, ctx) => {
    // appearance 值级门禁：zoom 必须是合法档位（ZOOM_LEVELS 单一真源）。settings:set
    // 通道防御；导入路径不过本 schema，靠渲染层读侧 clampZoom 归一——双防线。
    if (cfg.key !== 'appearance') {
      return;
    }
    const value = cfg.value as { zoom?: unknown } | null | undefined;
    if (value === null || value === undefined || typeof value !== 'object') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'appearance 配置必须是非空对象（{zoom}）',
      });
      return;
    }
    if (!ZOOM_LEVELS.includes(value.zoom as number)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `appearance.zoom 必须是合法缩放档位（${ZOOM_LEVELS.join('/')}）`,
      });
    }
  })
  .superRefine((cfg, ctx) => {
    // terminal 值级门禁：shell / fontSize 必须是合法档位（TERMINAL_SHELL_CHOICES /
    // TERMINAL_FONT_SIZES 单一真源）。档位集含平台不适用项——跨平台写入合法，
    // 平台适用性由主进程读侧收窄（与 proxy fail-open 同款取舍）。settings:set 通道
    // 防御；导入路径不过本 schema，靠渲染层读侧 clampFontSize 归一——双防线。
    if (cfg.key !== 'terminal') {
      return;
    }
    const value = cfg.value as { shell?: unknown; fontSize?: unknown } | null | undefined;
    if (value === null || value === undefined || typeof value !== 'object') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'terminal 配置必须是非空对象（{shell, fontSize}）',
      });
      return;
    }
    if (!TERMINAL_SHELL_CHOICES.includes(value.shell as never)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `terminal.shell 必须是合法档位（${TERMINAL_SHELL_CHOICES.join('/')}）`,
      });
    }
    if (!TERMINAL_FONT_SIZES.includes(value.fontSize as number)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `terminal.fontSize 必须是合法档位（${TERMINAL_FONT_SIZES.join('/')}）`,
      });
    }
  })
  .superRefine((cfg, ctx) => {
    // editor 值级门禁：wordWrap / tabSize 字段存在时才校验——部分写入合并语义，
    // 只写 fontSize / vimMode 的调用方不受影响。settings:set 通道防御；导入路径
    // 不过本 schema，靠渲染层读侧 clampEditorTabSize 兜底——双防线。
    if (cfg.key !== 'editor') {
      return;
    }
    const value = cfg.value as { wordWrap?: unknown; tabSize?: unknown } | null | undefined;
    if (value === null || value === undefined || typeof value !== 'object') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'editor 配置必须是非空对象（{fontSize, vimMode, wordWrap?, tabSize?}）',
      });
      return;
    }
    if (value.wordWrap !== undefined && typeof value.wordWrap !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'editor.wordWrap 必须是布尔值',
      });
    }
    if (value.tabSize !== undefined && !EDITOR_TAB_SIZES.includes(value.tabSize as number)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `editor.tabSize 必须是合法档位（${EDITOR_TAB_SIZES.join('/')}）`,
      });
    }
  });

/** settings:set 响应 */
export const SettingsSetResSchema = z.object({
  ok: z.boolean(),
});

/**
 * settings:event:changed 事件 payload（主进程主动变更某个设置域后的推送）
 *
 * 正常路径下设置由渲染层写入（`settings:set`），渲染层 store 即真源；但托盘菜单等
 * **主进程主动写入**（如「关闭时最小化到托盘」改 `window.closeAction`）绕过了渲染层
 * store ⇒ 不推送会让设置页显示旧值，且后续任何其它设置变更都会把旧值写回、静默覆盖
 * （丢更新，见 docs/implementation/30-residency-fix-spec.md §3 P2-6）。
 *
 * `key` 复用 `SETTING_KEYS`（与 settings:set 同一域清单），`value` 为该域的完整新值。
 */
export const SettingsChangedPayloadSchema = z.object({
  key: z.enum(SETTING_KEYS),
  value: z.unknown(),
});

/** settings:event:changed 事件 payload 类型 */
export interface SettingsChangedPayload {
  /** 变更的设置域（settings-store 的 key） */
  readonly key: (typeof SETTING_KEYS)[number];
  /** 该域的完整新值（渲染层按域合并，不做整快照覆盖） */
  readonly value: unknown;
}

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
 * 遥测级别（对标 VS Code telemetry.telemetryLevel 三档）
 *
 * 当前实现只区分「是否初始化 OTel」：off 跳过初始化，其余档位初始化后行为一致
 * （OTLP 端点未配置则不外发）。
 *
 * - off：不初始化 OpenTelemetry，不上报任何数据
 * - error-only：初始化遥测（语义上仅错误，当前实现与 full 同路径）
 * - full：初始化遥测（默认档，见主进程 telemetry-pref 的 DEFAULT_LEVEL）
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
/**
 * 能力覆盖（高级配置手填项；省略字段 = 回退内置清单 capabilities）。
 * 三态语义：Add 省略 = 未填写；Update 省略 = 不修改，null = 清除覆盖。
 */
export const ModelCapabilitiesOverrideSchema = z
  .object({
    contextWindowSize: z.number().int().positive().max(10_000_000).nullable().optional(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).nullable().optional(),
    vision: z.boolean().nullable().optional(),
  })
  // null/undefined 字段收敛为缺省（输出干净的可选 number/boolean，兼容 RuntimeCapabilitiesOverride
  // 的 exactOptionalPropertyTypes 判定）；Update 清除覆盖走外层 capabilities 的 null 三态
  .transform((v) => {
    const out: {
      contextWindowSize?: number;
      maxOutputTokens?: number;
      vision?: boolean;
    } = {};
    if (typeof v.contextWindowSize === 'number') {
      out.contextWindowSize = v.contextWindowSize;
    }
    if (typeof v.maxOutputTokens === 'number') {
      out.maxOutputTokens = v.maxOutputTokens;
    }
    if (typeof v.vision === 'boolean') {
      out.vision = v.vision;
    }
    return out;
  });

/** 能力覆盖 TypeScript 类型（transform 收敛后的干净可选字段） */
export type ModelCapabilitiesOverride = z.infer<typeof ModelCapabilitiesOverrideSchema>;

export const AddRuntimeModelReqSchema = z.object({
  // 模型 id（全局唯一，如 custom-coder）
  modelId: z.string().min(1).max(100),
  // 所属供应商 kind（决定 SDK 协议与默认端点）
  providerKind: ApiKeyProviderSchema,
  // 显式 baseUrl（覆盖供应商默认端点；省略 = 用默认）
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 API Key（省略 = 走 keychain 的 <kind>-api-key）
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  // 展示名称（省略 = 回退 modelId）
  displayName: z
    .string()
    .max(32)
    .optional()
    .transform((v) => v ?? undefined),
  // 单回合总时长上限（毫秒；省略 = 不限制，仅流空闲超时兜底）；上限 86_400_000 = 24h 护栏
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  // 启停状态（省略 = 启用）
  isEnabled: z.boolean().optional(),
  // API 协议格式（省略 = openai-chat，与存量行为一致——见 ModelApiFormatSchema）
  apiFormat: ModelApiFormatSchema.optional(),
  // 能力覆盖（高级配置；省略 = 未填写，resolve 回退内置清单）。
  // 允许显式 undefined（IPC handler 透传形态）——exactOptionalPropertyTypes 下 handler
  // 展开字段可能带 undefined 值
  capabilities: ModelCapabilitiesOverrideSchema.optional(),
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
  // 展示名称（省略 = 不修改）
  displayName: z
    .string()
    .max(32)
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 baseUrl（省略 = 不修改）
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 API Key（省略 = 不修改，传入则更新 keychain）
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  // 单回合总时长上限（毫秒；三态：省略 = 不修改，null = 清除（回不限制），number = 设置）
  timeoutMs: z.number().int().positive().max(86_400_000).nullable().optional(),
  // API 协议格式（省略 = 不修改）
  apiFormat: ModelApiFormatSchema.optional(),
  // 启停状态（省略 = 不修改）
  isEnabled: z.boolean().optional(),
  // 能力覆盖（三态：省略 = 不修改，null = 清除覆盖回退内置清单）
  capabilities: ModelCapabilitiesOverrideSchema.nullable().optional(),
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
  /** 单回合总时长上限（毫秒；省略 = 未设置，不限制） */
  readonly timeoutMs?: number;
  /** API 协议格式（省略 = openai-chat；仅自定义模式写非默认值） */
  readonly apiFormat?: ModelApiFormat;
  /** 启停状态（false = 已停用，不注册进 ModelRegistry、不可路由） */
  readonly isEnabled: boolean;
  /** 创建时间（Unix timestamp 毫秒） */
  readonly createdAt: number;
  /** 能力覆盖（高级配置手填项；省略 = 未覆盖，回退内置清单） */
  readonly capabilities?: ModelCapabilitiesOverride;
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
      timeoutMs: z.number().int().positive().max(86_400_000).optional(),
      apiFormat: ModelApiFormatSchema.optional(),
      isEnabled: z.boolean(),
      createdAt: z.number().int(),
      capabilities: ModelCapabilitiesOverrideSchema.optional(),
    }),
  ),
});

/**
 * 工具审批模式（对齐 qwen ApprovalMode 谱系，配置化四档）
 *
 * - plan：只读探索，写工具直接拒绝（Plan/Apply 分离的只读阶段）
 * - ask：写工具均需用户审批（保守默认）
 * - auto：工作区编辑自动放行，危险命令（exec 类）仍审批
 * - yolo：全部自动放行（仅信任环境使用）
 */
export const ApprovalModeSchema = z.enum(['plan', 'ask', 'auto', 'yolo']);

/** 工具审批模式 TypeScript 类型 */
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** 默认审批模式（保守：写操作均需审批；主进程 approval-pref 与权限服务共用此值） */
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

// ─── 设置导出/导入（app_settings 全表 JSON；keychain 凭据除外） ─────────

/**
 * 当前设置导出文件格式版本（导入侧仅接受本版本）
 *
 * 导出内容 = app_settings 表全量 key-value；API Key 等凭据存于系统 keychain
 * （safeStorage 加密，本机绑定不可迁移），不在导出文件内——这是显式安全取舍。
 */
export const SETTINGS_EXPORT_VERSION = 1;

/** 设置导出文件 schema（version=1；导入逐键过 SETTING_KEYS 白名单后才写入） */
export const SettingsExportFileSchema = z.object({
  version: z.literal(SETTINGS_EXPORT_VERSION),
  /** 导出时刻（Unix timestamp 毫秒） */
  exportedAt: z.number().int(),
  settings: z.record(z.string(), z.unknown()),
});

/** 设置导出文件类型 */
export type SettingsExportFile = z.infer<typeof SettingsExportFileSchema>;

/** settings:export 响应 payload（saved/path，与 session:exportAll 同形） */
export interface SettingsExportRes {
  /** 是否已写出文件（用户在对话框取消时为 false） */
  readonly saved: boolean;
  /** 写出路径（仅 saved=true 时存在） */
  readonly path?: string;
}

/** settings:export 响应 zod schema（响应契约校验用） */
export const SettingsExportResSchema = z.object({
  saved: z.boolean(),
  path: z.string().optional(),
});

/**
 * settings:import 响应 payload
 *
 * imported = 通过白名单校验并写入的键数；skipped = 白名单外被跳过的键数。
 */
export interface SettingsImportRes {
  /** 通过白名单校验并写入的键数 */
  readonly imported: number;
  /** 白名单外被跳过的键数 */
  readonly skipped: number;
}

/** settings:import 响应 zod schema（响应契约校验用） */
export const SettingsImportResSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
