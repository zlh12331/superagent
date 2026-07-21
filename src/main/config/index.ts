// src/main/config/index.ts
// 应用配置：从 process.env 读取，zod 校验，提供类型安全的单例
// 设计文档 §2.6 监控与运维配置
//
// dev 环境：electron-vite 自动注入 .env 变量到 process.env
// 生产环境：通过打包配置或环境变量提供
//
// 敏感数据（API Key）不存此处，由 keychain.ts 管理
//
// 说明：原 PostgreSQL/Ollama 配置已随数据库层一并删除，
// 当前仅保留应用级配置（isDev/isPackaged/logLevel/sentry/deepseek）。

import { app } from 'electron';
import { z } from 'zod';

/**
 * Sentry 配置
 */
const SentryConfigSchema = z.object({
  /** Sentry DSN（自托管 v26.6.0） */
  dsn: z.string().default(''),
  /** 事务采样率（0-1） */
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
  /** 请求超时（毫秒） */
  timeout: z.number().int().positive().default(60_000),
});

/**
 * 应用配置 Schema
 *
 * 仅包含应用运行所需的最基础配置项：
 * - 环境标识（isDev/isPackaged）
 * - 日志级别
 * - Sentry 监控配置
 * - DeepSeek AI 服务配置
 */
const AppConfigSchema = z.object({
  /** 是否为开发环境 */
  isDev: z.boolean(),
  /** 是否为打包后的生产环境 */
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
 * 从 process.env 加载并校验配置
 *
 * @returns 校验后的应用配置单例
 */
export function loadConfig(): AppConfig {
  const isPackaged = app.isPackaged;
  const isDev = !isPackaged;

  // noPropertyAccessFromIndexSignature: process.env 是 NodeJS.ProcessEnv 索引签名
  // 必须用 ['KEY'] 方括号语法访问，不能用 . 属性访问
  const env = process.env;
  return AppConfigSchema.parse({
    isDev,
    isPackaged,
    logLevel: env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
    sentry: {
      dsn: env['SENTRY_DSN'] ?? '',
      tracesSampleRate: Number(env['SENTRY_TRACES_SAMPLE_RATE'] ?? 0.1),
    },
    deepseek: {
      apiBase: env['DEEPSEEK_API_BASE'] ?? 'https://api.deepseek.com',
      model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
      timeout: Number(env['DEEPSEEK_TIMEOUT'] ?? 60_000),
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
