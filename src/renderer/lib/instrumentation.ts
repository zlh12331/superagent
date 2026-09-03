// src/renderer/lib/instrumentation.ts
// 渲染层可观测性初始化（Sentry renderer）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-04 缺陷修复）：渲染层 AppErrorBoundary / SectionErrorBoundary
// 调用 Sentry.captureException / captureMessage，但从未调用 SentryRenderer.init()——
// @sentry/electron 7 在未 init 时 window.__SENTRY__RENDERER_INIT__ 未置位，
// browser SDK 无 client，captureException 是空操作 → 渲染层错误事件全部静默丢弃，
// 而边界组件注释声称"renderer → main → OTLP"（虚假的可靠性承诺）。
//
// 本模块补齐渲染层初始化：
// - init() 后 events 经 IPC（sentry-ipc namespace）转发 main 进程，由 main 上传
//   （@sentry/electron 的 makeRendererTransport；main 进程负责接收并上报）
// - 仅 production 初始化：dev 环境 Sentry 包裹累积开销大（实测 198.6s 慢事件），
//   且 dev 错误 Chrome DevTools 即可见，无上报价值（与雪花工程实践一致）
// - test 环境（MODE==='test'）跳过：避免测试错误污染线上 Sentry
//
// 必须在 React render 之前调用（main.tsx 顶部同步 import 即可触发）
// ──────────────────────────────────────────────────────────────

import * as SentryRenderer from '@sentry/electron/renderer';

/**
 * 渲染层 Sentry 初始化
 *
 * 同步执行（init 内部走 browser SDK，无需 await）：
 * - MODE === 'web'（前端独立开发）：无 Electron preload，跳过（IPC 通道不存在）
 * - MODE === 'test'（vitest）：跳过（测试错误不上报）
 * - DEV（electron-vite dev / vite dev）：跳过（开发错误本地可见，无上报价值）
 * - production：完整初始化，错误经 IPC 转发 main 进程上传
 *
 * 环境判定顺序：web（无 preload 特判）> test（不上报）> dev（跳过）> prod（启用）。
 */
export function initRendererInstrumentation(): void {
  // MODE 在 Vite 构建时静态注入（web/test 分支 production bundle 不会命中）
  const mode = import.meta.env.MODE;
  if (mode === 'web' || mode === 'test') {
    return;
  }
  // DEV 由 Vite 按构建模式注入（true = dev server 运行，false = 生产构建）
  if (import.meta.env.DEV === true) {
    return;
  }

  SentryRenderer.init({
    // 采样：Session Replay 仅 production 低采样录制普通会话、出错会话全采样
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
