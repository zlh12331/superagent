// config/index.ts：应用配置单一真源——环境判定（appEnv/isDev/isTest/isPackaged）、供应商根地址表、
// 全局模型超时；zod 校验 + 惰性单例。边界：只解析 process.env，不负责加载 .env（main 入口在 whenReady 前完成）
import { app } from 'electron';
import { z } from 'zod';

// ───── Schema 定义 ─────

const AppEnvSchema = z.enum(['development', 'production', 'test']);

// 各供应商根地址（ProviderRegistry 消费，协议路径由 registry 拼接）：OpenAI Compatible 系不含 /v1，
// anthropic 例外直接使用根地址；同名 <PROVIDER>_API_BASE 环境变量优先于默认值（自托管网关/代理场景）。
// 新增供应商：此处 + ProviderRegistry 同步扩展
const ProviderBaseUrlSchema = z.object({
  deepseek: z.preprocess(
    (v) => process.env['DEEPSEEK_API_BASE'] ?? v,
    z.string().url().default('https://api.deepseek.com'),
  ),
  openai: z.preprocess(
    (v) => process.env['OPENAI_API_BASE'] ?? v,
    z.string().url().default('https://api.openai.com'),
  ),
  anthropic: z.preprocess(
    (v) => process.env['ANTHROPIC_API_BASE'] ?? v,
    z.string().url().default('https://api.anthropic.com'),
  ),
  ollama: z.preprocess(
    (v) => process.env['OLLAMA_API_BASE'] ?? v,
    z.string().url().default('http://localhost:11434'),
  ),
  moonshot: z.preprocess(
    (v) => process.env['MOONSHOT_API_BASE'] ?? v,
    z.string().url().default('https://api.moonshot.cn/v1'),
  ),
  zhipu: z.preprocess(
    (v) => process.env['ZHIPU_API_BASE'] ?? v,
    z.string().url().default('https://open.bigmodel.cn/api/paas/v4'),
  ),
  qwen: z.preprocess(
    (v) => process.env['QWEN_API_BASE'] ?? v,
    z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  ),
  doubao: z.preprocess(
    (v) => process.env['DOUBAO_API_BASE'] ?? v,
    z.string().url().default('https://ark.cn-beijing.volces.com/api/v3'),
  ),
  siliconflow: z.preprocess(
    (v) => process.env['SILICONFLOW_API_BASE'] ?? v,
    z.string().url().default('https://api.siliconflow.cn/v1'),
  ),
  openrouter: z.preprocess(
    (v) => process.env['OPENROUTER_API_BASE'] ?? v,
    z.string().url().default('https://openrouter.ai/api/v1'),
  ),
  mimo: z.preprocess(
    (v) => process.env['MIMO_API_BASE'] ?? v,
    z.string().url().default('https://api.xiaomimimo.com/v1'),
  ),
});

// 全局模型超时兜底（模型自带 timeoutMs 优先，消费方 llm-client → AbortSignal.timeout）。
// MODEL_TIMEOUT_MS 须为有限正数才采纳，坏值静默回落默认 60s 而非 parse 报错
const ModelTimeoutMsSchema = z.preprocess((v) => {
  const raw = process.env['MODEL_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return v;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : v;
}, z.number().int().positive().default(60000));

const AppConfigSchema = z.object({
  appEnv: AppEnvSchema, // 运行环境真源；isDev/isTest 是派生字段
  isDev: z.boolean(), // appEnv !== 'production'：test 本质是开发环境特化（仅超时缩短），保留 devtools/CSP 宽松等开发行为，故并入 isDev
  isTest: z.boolean(),
  isPackaged: z.boolean(), // 运行时事实，与 appEnv 正交——APP_ENV 可覆盖出 isPackaged=true + appEnv=development 组合
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  providers: ProviderBaseUrlSchema,
  modelTimeoutMs: ModelTimeoutMsSchema,
});

/** 应用配置类型（schema 派生） */
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ───── 环境判定与加载 ─────

// 优先级：APP_ENV 显式覆盖（CI/E2E 强制场景）> NODE_ENV=test（Vitest 自动设）> app.isPackaged 运行时事实；
// APP_ENV 非法值不报错，落到下一层推断
function resolveAppEnv(isPackaged: boolean): 'development' | 'production' | 'test' {
  const env = process.env;
  const explicit = env['APP_ENV'];
  if (explicit === 'development' || explicit === 'production' || explicit === 'test') {
    return explicit;
  }
  if (env['NODE_ENV'] === 'test') {
    return 'test';
  }
  return isPackaged ? 'production' : 'development';
}

/**
 * 从 process.env 解析并校验应用配置（每次调用重新解析，不缓存；常规取用走 getAppConfig）
 *
 * @returns 校验通过的应用配置
 */
export function loadConfig(): AppConfig {
  const isPackaged = app.isPackaged;
  const appEnv = resolveAppEnv(isPackaged);
  const isDev = appEnv !== 'production';
  const isTest = appEnv === 'test';

  // 默认级别按环境分级：test 安静（error）/开发 debug/生产 info
  const defaultLogLevel: 'debug' | 'info' | 'error' = isTest ? 'error' : isDev ? 'debug' : 'info';

  const env = process.env;
  return AppConfigSchema.parse({
    appEnv,
    isDev,
    isTest,
    isPackaged,
    logLevel: env['LOG_LEVEL'] ?? defaultLogLevel,
    providers: {},
    // test 缩到 5s 防测试真等 60s；undefined 交由 schema default 接管
    modelTimeoutMs: isTest ? 5000 : undefined,
  });
}

// ───── 单例 ─────

let cachedConfig: AppConfig | null = null;

/**
 * 应用配置单例：首次调用解析并缓存
 *
 * 前置条件：app.whenReady() 之后调用（依赖 app.isPackaged）
 */
export function getAppConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * 重置配置缓存。仅测试用——生产代码没有需要重新加载的路径
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
