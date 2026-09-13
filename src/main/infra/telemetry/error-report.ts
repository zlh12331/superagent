// src/main/infra/telemetry/error-report.ts
// 错误上报单一出口缝（2026-09-13 引入）
// ──────────────────────────────────────────────────────────────
// 背景：Sentry 移除（路线 4 本地优先，见 docs/design/23-otel-spec.md 调整记录）。
// 此前 wrap / logger 崩溃路径 / 渲染崩溃自愈 / 内存与事件循环告警等
// 6 处上报点直接调用 @sentry/electron——现全部收敛到本模块。
//
// 当前实现：结构化本地日志（electron-log 落盘，随诊断包导出）。
// 将来接任何后端（Sentry / GlitchTip / OTel exception events）只改本文件，
// 调用方不动——这是"可回插"的设计承诺。
//
// 注意：不再区分"上报失败静默降级"——本实现只写本地日志，不会抛错。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';

/** 错误上报上下文（结构化字段，随日志落盘） */
export interface ErrorReportContext {
  /** 分组/来源标签（原 Sentry tags 语义） */
  readonly tags?: Readonly<Record<string, string>>;
  /** React 组件栈（错误边界场景，帮助定位出错组件） */
  readonly componentStack?: string;
}

/**
 * 上报错误（原 Sentry.captureException 收敛点）
 *
 * @param error 任意错误（Error / string / unknown reason）
 * @param context 结构化上下文（tags / componentStack）
 */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  logger.error(
    {
      ...(context?.tags ?? {}),
      ...(context?.componentStack !== undefined ? { componentStack: context.componentStack } : {}),
    },
    '错误上报',
    error,
  );
}

/**
 * 上报消息级事件（原 Sentry.captureMessage 收敛点）
 *
 * 供非 Error 的系统事件使用：进程崩溃自愈 / 内存告警 / 事件循环阻塞等。
 *
 * @param message 消息文本
 * @param level 严重级别（warning → 日志 warn；error → 日志 error）
 */
export function reportMessage(message: string, level: 'error' | 'warning' = 'error'): void {
  if (level === 'warning') {
    logger.warn({ scope: 'error-report' }, message);
  } else {
    logger.error({ scope: 'error-report' }, message);
  }
}
