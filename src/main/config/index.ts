// src/main/config/index.ts
// 应用配置：从 process.env 读取，zod 校验，提供类型安全的单例
// 设计文档 §2.6 监控与运维配置
//
// dev 环境：electron-vite 自动注入 .env 变量到 process.env
// 生产环境：通过打包配置或环境变量提供
//
// 敏感数据（API Key）不存此处，由 keychain.ts 管理

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
 * Ollama 本地嵌入服务配置
 */
const OllamaConfigSchema = z.object({
  /** Ollama 服务 URL */
  url: z.string().url().default('http://localhost:11434'),
  /** 嵌入模型名 */
  embedModel: z.string().default('nemotron-3-embed-1b-bf16'),
  /** 嵌入向量维度 */
  embedDimensions: z.number().int().positive().default(2048),
  /** 健康探活间隔（毫秒） */
  healthCheckInterval: z.number().int().positive().default(30_000),
});

/**
 * 应用配置 Schema
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
  /** Ollama 嵌入服务配置 */
  ollama: OllamaConfigSchema,
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

  return AppConfigSchema.parse({
    isDev,
    isPackaged,
    logLevel: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    sentry: {
      dsn: process.env.SENTRY_DSN ?? '',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    },
    deepseek: {
      apiBase: process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      timeout: Number(process.env.DEEPSEEK_TIMEOUT ?? 60_000),
    },
    ollama: {
      url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nemotron-3-embed-1b-bf16',
      embedDimensions: Number(process.env.OLLAMA_EMBED_DIMENSIONS ?? 2048),
      healthCheckInterval: Number(process.env.OLLAMA_HEALTH_CHECK_INTERVAL ?? 30_000),
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
