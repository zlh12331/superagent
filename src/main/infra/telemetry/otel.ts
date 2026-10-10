import type { Tracer } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { readTelemetryLevelSync } from '../storage/telemetry-pref';

let tracer: Tracer | null = null;

let initialized = false;

let tracerProvider: NodeTracerProvider | null = null;

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

export function getTracer(): Tracer | null {
  return tracer;
}

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
