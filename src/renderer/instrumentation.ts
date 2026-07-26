// src/renderer/instrumentation.ts
// 渲染层可观测性初始化（Sentry renderer + Performance + Session Replay）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 初始化 @sentry/electron/renderer（自动通过 IPC 转发到 main 进程的 Sentry）
// - 启用 Performance Monitoring（BrowserTracing：页面加载、路由跳转、用户交互）
// - 启用 Session Replay（DOM 快照录制，用户操作回放）
//
// 必须在 React render 之前调用（main.tsx 顶部 import 即可）
//
// 设计决策：
// - 渲染层 OpenTelemetry stub 已移除：@sentry/electron/renderer 的自动
//   instrumentation 已覆盖 uncaught exceptions / console errors / fetch 错误，
//   足以覆盖桌面应用 renderer 进程的可观测性需求。
// - dev 环境完全跳过 Sentry renderer 初始化：
//   - sentryWrapped 包裹累积开销巨大（实测 trace：198.6 秒累积耗时，158 个慢事件）
//   - @sentry/electron 模块解析 116s + 编译 12.9s
//   - rrwebWrapped DOM 序列化触发强制回流
//   - dev 错误在 Chrome DevTools console 可见，无需上报
//   - dev 性能用 Chrome DevTools Performance 面板更准确
//   - Session Replay 在 dev 无意义（直接看屏幕）
//   - 仅保留 main 进程 Sentry 用于生产错误上报
// - Performance Monitoring（仅 production）：
//   - browserTracingIntegration 自动 instrument 页面加载（pageload）和路由切换（navigation）
//   - 配合 main 进程的 tracesSampleRate=1.0（dev）实现 100% 采样
//   - 数据通过 IPC 转发到 main，由 main 上报到 Sentry 服务端
// - Session Replay（仅 production）：
//   - replayIntegration 从 @sentry/browser 重新导出（renderer/index.d.ts）
//   - 录制数据通过 IPC 转发到 main，由 main 上报到 Sentry 服务端
//   - 遮罩敏感文本 + 阻塞媒体（隐私合规）
// ──────────────────────────────────────────────────────────────

import * as SentryRenderer from '@sentry/electron/renderer';
import { browserTracingIntegration, replayIntegration } from '@sentry/electron/renderer';

/**
 * 渲染层可观测性初始化
 *
 * Sentry renderer：@sentry/electron 7 原生支持，自动通过 IPC 转发到 main，
 * 用户无需配置 DSN。main 进程未初始化 Sentry 时，renderer 自动跳过。
 *
 * dev 环境：完全跳过初始化
 * - sentryWrapped/rrwebWrapped 累积开销巨大，污染 dev 性能数据
 * - Chrome DevTools console + Performance 面板已覆盖 dev 调试需求
 * - main 进程 Sentry 仍生效（捕获 main 进程错误）
 *
 * production：完整初始化 Performance Monitoring + Session Replay
 * - browserTracingIntegration() 自动 instrument 页面加载 + 路由切换
 * - replayIntegration() DOM 录制（出错 session 100% 采样）
 * - 配合 main 进程 tracesSampleRate 实现采样
 */
export function initRendererInstrumentation(): void {
  // 判断是否为开发环境
  // renderer 进程中 import.meta.env.DEV 由 Vite 注入
  const isDev = import.meta.env.DEV === true;

  // dev 环境：完全跳过 Sentry renderer 初始化
  // 实测 trace 显示 Sentry 在 dev 环境累积 198.6 秒慢事件（158 个），
  // 其中 sentryWrapped 包裹 + rrwebWrapped DOM 序列化 + 模块解析编译
  // 占用大量主线程时间，严重污染性能数据且无调试价值
  if (isDev) {
    return;
  }

  SentryRenderer.init({
    // Session Replay 采样配置
    // - production：10% 录制普通 session，100% 录制出错 session
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      // Performance Monitoring：自动 instrument 页面加载（pageload）和路由切换（navigation）
      // Electron 桌面应用首次加载会产生 1 个 pageload transaction
      // tracesSampleRate 在 main 进程配置（IPC 转发后由 main 采样）
      browserTracingIntegration({
        // 启用用户交互追踪（click → ui.action.click span）
        // 默认 false，开启后点击交互会生成 interaction span
        // Electron 桌面应用无 URL 路由导航，交互 span 是主要的性能数据来源之一
        _experiments: { enableInteractions: true },
      }),
      // Session Replay：production 立即加载（需要从第一帧开始录制错误上下文）
      replayIntegration({
        // production 遮罩敏感文本
        maskAllText: true,
        // production 阻塞媒体元素（<img>/<video> 不录制）
        blockAllMedia: true,
        // 遮罩所有 input 值（密码、API Key 等敏感输入始终遮罩）
        maskAllInputs: true,
        // 不录制网络请求 body（避免泄露 API Key）
        networkDetailAllowUrls: [],
      }),
    ],
  });
}
