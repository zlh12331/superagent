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
 * NodeTracerProvider 实例引用
 *
 * register() 注册到全局的 provider 是 ProxyTracerProvider（无 forceFlush/shutdown），
 * shutdownTelemetry 必须用本引用收尾，否则退出时在途 span 导出丢失。
 */
let tracerProvider: NodeTracerProvider | null = null;

/**
 * 初始化 OpenTelemetry
 *
 * 必须在 app.whenReady() 之后调用（需要 app.getVersion）
 *
 * 配置策略：
 * - OTEL_EXPORTER_OTLP_ENDPOINT 环境变量存在：用 OTLP HTTP exporter
 * - 不存在且 dev：用 ConsoleSpanExporter（便于本地调试）
 * - 不存在且打包版：不注册（span 属性含路径/上下文，不打 stdout）
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

    if ((endpoint === undefined || endpoint === '') && app.isPackaged) {
      logger.info({}, 'OpenTelemetry 未初始化（打包版未配置 OTLP 端点）');
      tracer = null;
      initialized = false;
      return;
    }

    let spanProcessor: SimpleSpanProcessor;
    if (endpoint !== undefined && endpoint !== '') {
      const exporter = new OTLPTraceExporter({ url: endpoint });
      spanProcessor = new SimpleSpanProcessor(exporter);
      logger.info({ endpoint }, 'OpenTelemetry 初始化完成（OTLP exporter）');
    } else {
      spanProcessor = new SimpleSpanProcessor(new ConsoleSpanExporter());
      logger.info({}, 'OpenTelemetry 初始化完成（Console exporter，dev only）');
    }

    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
    });

    provider.register();
    tracerProvider = provider;
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
    return fn(undefined as unknown as import('@opentelemetry/api').Span);
  }

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.setStatus({
        code: 2,
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
    if (tracerProvider === null) {
      logger.warn({}, 'OpenTelemetry provider 引用缺失，跳过 flush');
      return;
    }
    await tracerProvider.forceFlush();
    await tracerProvider.shutdown();
    tracerProvider = null;
    logger.info({}, 'OpenTelemetry 已关闭');
  } catch (error) {
    logger.warn({ error }, 'OpenTelemetry 关闭失败');
  } finally {
    initialized = false;
    tracer = null;
  }
}
