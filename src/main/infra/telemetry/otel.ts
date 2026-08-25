// src/main/telemetry/otel.ts
// 主进程 OpenTelemetry 初始化（Tracing + Metrics）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 初始化 NodeTracerProvider（trace）
// - 初始化 MeterProvider（metrics，counter + histogram）
// - 配置 OTLP Exporter（HTTP/gRPC，端点从 OTEL_EXPORTER_OTLP_ENDPOINT 读取）
// - 失败容忍：未配置端点时退化为 ConsoleSpanExporter（仅 dev）
//
// 设计：
// - 桌面应用主进程是长期运行的 Node 进程，适合 OTel Node SDK
// - 与 Sentry 互补：Sentry 采集错误 + Performance，
//   OTel 采集自定义业务指标 + 分布式 trace（未来扩展 MCP 工具链路）
// - 资源占用：OTel SDK 约增加 5-10MB 内存，对桌面应用可接受
// ──────────────────────────────────────────────────────────────

import type { Tracer } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { readTelemetryLevelSync } from '../storage/telemetry-pref';

/**
 * 全局 Tracer 实例
 *
 * 使用方式：
 * ```ts
 * const span = tracer.startSpan('agent.streamText');
 * try {
 *   // 业务逻辑
 * } finally {
 *   span.end();
 * }
 * ```
 */
let tracer: Tracer | null = null;

/**
 * OTel 是否已初始化
 *
 * false 时所有 telemetry 函数为 no-op，不影响业务逻辑
 */
let initialized = false;

/**
 * 初始化 OpenTelemetry
 *
 * 必须在 app.whenReady() 之后调用（需要 app.getVersion）
 *
 * 配置策略：
 * - OTEL_EXPORTER_OTLP_ENDPOINT 环境变量存在：用 OTLP HTTP exporter
 * - 不存在：用 ConsoleSpanExporter（仅 dev 环境，便于调试）
 * - 任何失败：标记为未初始化，业务代码继续运行
 */
export function initTelemetry(): void {
  if (initialized) {
    return;
  }

  try {
    const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    const serviceName = `code-agent-agent-${app.isPackaged ? 'prod' : 'dev'}`;
    const serviceVersion = app.getVersion();

    // P2 修复：尊重用户遥测级别——'off' 时完全不注册 provider。此前设置页的
    // 「关闭遥测」只作用于 Sentry，OTel spans 照常导出（级别语义不一致）。
    // 'error'/'full' 对 traces 语义相同（span 是链路而非错误日志），仅 off 控制启停；
    // Sentry 级别仍受重启限制（见 settings.handler setTelemetryLevel 注释）。
    if (readTelemetryLevelSync() === 'off') {
      logger.info({}, 'OpenTelemetry 未初始化（遥测级别 = off）');
      tracer = null;
      initialized = false;
      return;
    }

    const resource = resourceFromAttributes({
      'service.name': serviceName,
      'service.version': serviceVersion,
      'service.namespace': 'code-agent',
      'host.arch': process.arch,
      'host.platform': process.platform,
    });

    // OTel v2.x：spanProcessors 在构造函数传入，不再支持 addSpanProcessor 方法
    let spanProcessor: SimpleSpanProcessor;
    if (endpoint !== undefined && endpoint !== '') {
      // 生产/远程开发：OTLP HTTP exporter
      const exporter = new OTLPTraceExporter({ url: endpoint });
      spanProcessor = new SimpleSpanProcessor(exporter);
      logger.info({ endpoint }, 'OpenTelemetry 初始化完成（OTLP exporter）');
    } else {
      // 开发：Console exporter，便于本地调试
      spanProcessor = new SimpleSpanProcessor(new ConsoleSpanExporter());
      logger.info({}, 'OpenTelemetry 初始化完成（Console exporter，dev only）');
    }

    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
    });

    provider.register();
    tracer = trace.getTracer('code-agent', serviceVersion);
    initialized = true;
  } catch (error) {
    logger.warn({ error }, 'OpenTelemetry 初始化失败，tracing 退化为 no-op');
    initialized = false;
  }
}

/**
 * 获取全局 Tracer
 *
 * 未初始化时返回 null，调用方应判空使用
 */
export function getTracer(): Tracer | null {
  return tracer;
}

/**
 * 创建一个 span 并自动结束
 *
 * 工具函数：包装一个 async 函数为带 trace 的版本
 *
 * 使用 startActiveSpan：fn 执行期间激活 span 为当前 context，
 * 使 fn 内部新建的 span（如 AI SDK telemetry 回调创建的模型调用 span）
 * 自动成为本 span 的子 span（OTel AsyncLocalStorage 跨 await 传播）。
 *
 * @example
 * ```ts
 * const result = await withSpan('agent.streamText', { sessionId }, async (span) => {
 *   span.setAttribute('model', 'deepseek');
 *   return await streamText({...});
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: import('@opentelemetry/api').Span) => Promise<T>,
): Promise<T> {
  if (!initialized || tracer === null) {
    // 未初始化：直接执行函数（不传 span）
    // 用 undefined as 不可变断言：业务代码必须容忍 span 为 undefined
    return fn(undefined as unknown as import('@opentelemetry/api').Span);
  }

  // startActiveSpan：激活 context + 自动 end（含异常路径）
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 /* OK */ });
      return result;
    } catch (error) {
      span.setStatus({
        code: 2 /* ERROR */,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      throw error;
    }
  });
}

/**
 * 关闭 OpenTelemetry
 *
 * 应用退出时调用，确保所有 span 已 flush 到 exporter
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!initialized) {
    return;
  }
  try {
    // NodeTracerProvider 的 forceFlush 会等待所有 span processor 完成
    const provider = trace.getTracerProvider() as NodeTracerProvider;
    await provider.forceFlush();
    await provider.shutdown();
    logger.info({}, 'OpenTelemetry 已关闭');
  } catch (error) {
    logger.warn({ error }, 'OpenTelemetry 关闭失败');
  } finally {
    initialized = false;
    tracer = null;
  }
}
