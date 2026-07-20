// src/main/config/index.ts
// 应用配置：从 process.env 读取，zod 校验，提供类型安全的单例
// 设计文档 §2.6 监控与运维配置
//
// dev 环境：electron-vite 自动注入 .env 变量到 process.env
// 生产环境：通过打包配置或环境变量提供
//
// 敏感数据（API Key）不存此处，由 keychain.ts 管理

import { POSTGRES_VERSIONS } from '@novel-writer/shared';
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
 * PostgreSQL 数据库配置
 *
 * 设计文档 §6.2 + §7.8
 * - 端口 5433 避免与系统 PG 5432 冲突
 * - dataDir 由 app-data.ts 提供（%APPDATA%/<AppName>/pgdata）
 * - 实际启动由 Phase 4b pg-controller 完成
 */
const PgConfigSchema = z.object({
  /** 数据库连接 URL（端口 5433 避免与系统 PG 5432 冲突） */
  url: z.string().url().default('postgresql://nwa@localhost:5433/nwa'),
  /** PG 数据目录（%APPDATA%/<AppName>/pgdata，由 app-data.ts 提供） */
  dataDir: z.string().default(''),
  /** PG 监听端口（与 url 中端口一致，pg-controller.start() 使用） */
  port: z.number().int().min(1).max(65535).default(5433),
  /** PG 数据库实例名 */
  database: z.string().default('nwa'),
  /** PG 启动超时（毫秒） */
  startTimeout: z.number().int().positive().default(30_000),
  /** PG 版本（默认 18.4，AGE 加载失败时降级到 17.10，设计文档 §6.5） */
  version: z.string().default(POSTGRES_VERSIONS.V18_4),
  /** PG 资源根目录（dev: 空字符串表示用系统 PATH；prod: resources/pg，设计文档 §6.5） */
  resourcesDir: z.string().default(''),
  /** initdb 超时（毫秒），首次启动初始化数据目录的超时上限 */
  initdbTimeout: z.number().int().positive().default(60_000),
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
  /** PostgreSQL 数据库配置 */
  pg: PgConfigSchema,
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
    ollama: {
      url: env['OLLAMA_URL'] ?? 'http://localhost:11434',
      embedModel: env['OLLAMA_EMBED_MODEL'] ?? 'nemotron-3-embed-1b-bf16',
      embedDimensions: Number(env['OLLAMA_EMBED_DIMENSIONS'] ?? 2048),
      healthCheckInterval: Number(env['OLLAMA_HEALTH_CHECK_INTERVAL'] ?? 30_000),
    },
    pg: {
      url: env['DATABASE_URL'] ?? 'postgresql://nwa@localhost:5433/nwa',
      dataDir: env['PG_DATA_DIR'] ?? '',
      port: Number(env['PG_PORT'] ?? 5433),
      database: env['PG_DATABASE'] ?? 'nwa',
      startTimeout: Number(env['PG_START_TIMEOUT'] ?? 30_000),
      version: env['PG_VERSION'] ?? POSTGRES_VERSIONS.V18_4,
      resourcesDir: env['PG_RESOURCES_DIR'] ?? '',
      initdbTimeout: Number(env['PG_INITDB_TIMEOUT'] ?? 60_000),
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
