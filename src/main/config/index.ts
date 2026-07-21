// src/main/config/index.ts
// 应用配置：从 process.env 读取，zod 校验，提供类型安全的单例
// 设计文档 §2.6 监控与运维配置
//
// P2-8 环境分层：
// - 显式 appEnv: 'development' | 'production' | 'test' 三态枚举
// - 优先级：APP_ENV > NODE_ENV > app.isPackaged 推断
// - test 环境由 Vitest 自动设置 NODE_ENV=test 触发
// - isDev / isTest / isPackaged 三个布尔派生字段（向后兼容）
//
// 环境特定默认值：
// - development：logLevel=debug、Sentry tracesSampleRate=0.1、DeepSeek timeout=60s
// - production：logLevel=info、Sentry tracesSampleRate=0.1、DeepSeek timeout=60s
// - test：logLevel=error（减少测试噪音）、Sentry dsn='' + tracesSampleRate=0（不上报）、
//         DeepSeek timeout=5s（测试不应等 60s 超时）
//
// 敏感数据（API Key）不存此处，由 keychain.ts 管理。

import { app } from 'electron';
import { z } from 'zod';

/**
 * 应用运行环境枚举
 *
 * - development：本地开发（electron-vite dev）
 * - production：打包发布（electron-builder 产物）
 * - test：自动化测试（Vitest 自动设置 NODE_ENV=test）
 */
const AppEnvSchema = z.enum(['development', 'production', 'test']);

/**
 * Sentry 配置
 */
const SentryConfigSchema = z.object({
  /** Sentry DSN（自托管 v26.6.0，test 环境强制为空字符串不上报） */
  dsn: z.string().default(''),
  /** 事务采样率（0-1，test 环境强制为 0 不采样） */
  tracesSampleRate: z.number().min(0).max(1).default(0.1),
});

/**
 * DeepSeek AI 配置
 */
const DeepseekConfigSchema = z.object({
  /** API 基础 URL */
  apiBase: z.string().url().default('https://api.deepseek.com'),
  /** 默认聊天模型 */
  model: z.string().default('deepseek-v4-flash'),
  /** 请求超时（毫秒，test 环境缩短为 5s） */
  timeout: z.number().int().positive().default(60_000),
});

/**
 * 应用配置 Schema
 *
 * P2-8 改造：新增 appEnv 字段作为环境真源，isDev/isTest/isPackaged 为派生字段
 *
 * isDev 包含 development 和 test 两种环境：
 * - test 环境本质是开发环境的特化（关闭 Sentry、缩短 timeout），
 *   但保留开发模式行为（devtools 可用、CSP 宽松等）
 * - 因此 isDev = (appEnv !== 'production')
 */
const AppConfigSchema = z.object({
  /** 运行环境（真源） */
  appEnv: AppEnvSchema,
  /** 是否为开发模式（appEnv !== 'production'，包含 development 和 test） */
  isDev: z.boolean(),
  /** 是否为测试环境（appEnv === 'test'） */
  isTest: z.boolean(),
  /** 是否为打包后的生产环境（运行时事实，独立于 appEnv） */
  isPackaged: z.boolean(),
  /** 日志级别 */
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Sentry 配置 */
  sentry: SentryConfigSchema,
  /** DeepSeek AI 配置 */
  deepseek: DeepseekConfigSchema,
});

/** 应用配置类型（从 schema 派生） */
export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * 推断运行环境
 *
 * 优先级：
 * 1. APP_ENV 显式覆盖（CI/E2E 强制 production 或 test）
 * 2. NODE_ENV=test（Vitest 自动设置，测试环境）
 * 3. app.isPackaged（运行时事实，true=production，false=development）
 *
 * @param isPackaged app.isPackaged 的值
 * @returns 推断出的运行环境
 */
function resolveAppEnv(isPackaged: boolean): 'development' | 'production' | 'test' {
  // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
  const env = process.env;
  // 1. APP_ENV 显式覆盖
  const explicit = env['APP_ENV'];
  if (explicit === 'development' || explicit === 'production' || explicit === 'test') {
    return explicit;
  }
  // 2. NODE_ENV=test（Vitest 自动设置）
  if (env['NODE_ENV'] === 'test') {
    return 'test';
  }
  // 3. 根据 isPackaged 推断
  return isPackaged ? 'production' : 'development';
}

/**
 * 从 process.env 加载并校验配置
 *
 * @returns 校验后的应用配置单例
 */
export function loadConfig(): AppConfig {
  const isPackaged = app.isPackaged;
  const appEnv = resolveAppEnv(isPackaged);
  // isDev 包含 development 和 test（test 是开发环境的特化，保留开发模式行为）
  const isDev = appEnv !== 'production';
  const isTest = appEnv === 'test';

  // 环境特定默认值
  // - test：logLevel=error（减少测试噪音）
  // - development：logLevel=debug（开发调试）
  // - production：logLevel=info（默认）
  const defaultLogLevel: 'debug' | 'info' | 'error' = isTest ? 'error' : isDev ? 'debug' : 'info';
  // test 环境强制不上报 Sentry（避免测试错误污染线上 Sentry）
  const defaultSentryDsn = isTest ? '' : '';
  // test 环境强制采样率为 0
  const defaultSentryTracesSampleRate = isTest ? 0 : 0.1;
  // test 环境缩短超时为 5s（测试不应等 60s 超时）
  const defaultDeepseekTimeout = isTest ? 5_000 : 60_000;

  // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
  const env = process.env;
  return AppConfigSchema.parse({
    appEnv,
    isDev,
    isTest,
    isPackaged,
    logLevel: env['LOG_LEVEL'] ?? defaultLogLevel,
    sentry: {
      dsn: env['SENTRY_DSN'] ?? defaultSentryDsn,
      tracesSampleRate: Number(env['SENTRY_TRACES_SAMPLE_RATE'] ?? defaultSentryTracesSampleRate),
    },
    deepseek: {
      apiBase: env['DEEPSEEK_API_BASE'] ?? 'https://api.deepseek.com',
      model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
      timeout: Number(env['DEEPSEEK_TIMEOUT'] ?? defaultDeepseekTimeout),
    },
  });
}

/**
 * 应用配置单例
 *
 * 注意：必须在 app.whenReady() 之后使用（依赖 app.isPackaged）
 */
let cachedConfig: AppConfig | null = null;

/**
 * 获取应用配置单例
 *
 * 首次调用时加载并缓存，后续调用返回缓存
 */
export function getAppConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * 重置配置缓存（仅测试用）
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
