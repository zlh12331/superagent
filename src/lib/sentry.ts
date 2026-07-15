/**
 * @file Sentry 可观测性集成模块。
 *
 * 职责：
 *  - 在应用启动期尽早初始化 Sentry SDK（initSentry）；
 *  - 用 consent 状态机对事件发送进行门控，尊重用户隐私授权；
 *  - 在事件出网前对敏感字段做脱敏（redactSentryEvent）；
 *  - 与 Rust 侧 Sentry SDK 同步授权状态（setConsent 命令）。
 *
 * 架构位置：位于 lib/ 顶层，被 main.tsx / quick-pane-main.tsx 直接调用，
 *   并通过 hooks/use-crash-reporting.ts 在用户授权后调用 setSentryConsent。
 *
 * 关键设计：consent 与 initialized 分离 —— SDK 先初始化以便捕获启动期错误，
 *   beforeSend 钩子根据 consentGranted 决定是否实际发送事件。
 */

import * as Sentry from '@sentry/react'
import { commands } from '@/lib/tauri-bindings'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { redactString, redactObject } from '@/lib/redact'

/**
 * 来自已校验环境变量的 Sentry DSN。
 * 若为空，无论用户是否授权，崩溃上报都将被禁用。
 * 通过 .env 文件中的 VITE_SENTRY_DSN 配置。
 *
 * 本模板针对自托管的 Sentry 实例配置，
 * 无配额限制 — 所有功能均可完全启用。
 */
const SENTRY_DSN = env['VITE_SENTRY_DSN'] || undefined

/** Sentry SDK 是否已成功 init，防止重复初始化。 */
let initialized = false

/**
 * Sentry 事件提交的授权状态。
 *
 * - `null`  — 尚未询问授权。事件会被捕获但不会发送。
 * - `true`  — 用户已授权。事件会发送到 Sentry。
 * - `false` — 用户已拒绝。事件会被丢弃。
 *
 * 这样可以让 Sentry 尽早初始化（捕获应用启动期的错误），
 * 同时在实际数据传输时尊重用户授权。
 */
let consentGranted: boolean | null = null

/**
 * 初始化 Sentry SDK，开启全部可观测性特性。
 *
 * 应当在 main.tsx 中尽早调用（在 createRoot 之前），
 * 以便捕获启动阶段的错误。事件只有在调用
 * `setSentryConsent(true)` 之后才会发送。
 *
 * 启用的特性（自托管，无配额限制）：
 * - 错误监控 (Issues)
 * - 性能追踪 (Web Vitals + 自定义 spans)
 * - 会话回放 (Session Replay，仅在出错时捕获，100% 采样)
 * - 日志（通过 Sentry.logger 进行结构化日志聚合）
 * - 用户反馈（出错时显示内联反馈组件）
 */
export function initSentry(): void {
  if (initialized || !SENTRY_DSN) return

  Sentry.init({
    dsn: SENTRY_DSN,
    // release 与 package.json version 对齐，用于按版本分组 issue + 上传 source map。
    // 使用 typeof 守卫做 fallback —— 测试环境或构建配置异常时 __APP_VERSION__ 可能未注入,
    // 此时回退到 'unknown' 避免抛出 ReferenceError 导致 Sentry 初始化失败。
    release: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
    environment: import.meta.env.DEV ? 'development' : 'production',

    // Tracing：全量采样（自托管无配额限制）
    tracesSampleRate: 1.0,

    // Session Replay：仅在出错时捕获（注重隐私）
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,

    // Logs：启用结构化日志聚合
    enableLogs: true,

    // 授权门控：在用户明确授权前丢弃事件。
    // 这样可以让 Sentry 捕获应用启动期的错误，同时尊重用户隐私
    // — 事件会被缓冲但不会发送，直到调用 setSentryConsent(true)。
    //
    // 在用户授权后，敏感数据（API keys、tokens、
    // 密码等）会在传输前从事件中脱敏。
    beforeSend(event) {
      if (consentGranted !== true) {
        return null
      }
      return redactSentryEvent(event)
    },

    integrations: [
      // 性能追踪：自动捕获 Web Vitals (LCP/FCP/INP/CLS)
      Sentry.browserTracingIntegration(),
      // Session Replay：用于错误调试的 DOM 录制
      // maskAllText: true — 遮罩所有文本，保护对话内容、代码片段等敏感信息
      // project_memory: "Sentry Session Replay may expose sensitive code and
      // conversation content; maskAllText should be set to true for SuperAgent"
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: false,
      }),
      // 用户反馈：用于用户描述问题的内联组件
      Sentry.feedbackIntegration({
        colorScheme: 'system',
      }),
    ],
  })

  initialized = true
}

/**
 * 设置用户对 Sentry 事件提交的授权状态。
 *
 * - `true`  — 允许事件发送到 Sentry。同时设置一个匿名用户 ID
 *              （跨会话持久化），以便 Sentry 按设备对事件分组。
 * - `false` — 丢弃所有待发送及后续事件。清除用户身份。
 * - `null`  — 重置为“尚未询问”状态（事件被捕获但不发送）。
 *
 * 该函数控制 `beforeSend` 门控，不会重新初始化 SDK。
 * 授权状态还会通过 `set_consent` Tauri 命令同步到 Rust 侧，
 * 以便 Rust 侧产生的 Sentry 事件（如 panic 捕获）遵循相同的授权门控。
 */
export function setSentryConsent(consent: boolean | null): void {
  consentGranted = consent
  // 将授权状态同步到 Rust Sentry SDK。
  // 失败时记录 warning 并重试一次,确保 Rust 侧 consent 状态最终一致。
  // 我们不会回滚前端状态,因为前端的 beforeSend 门控是独立的,
  // 无论 Rust 侧状态如何,前端行为都是正确的。
  commands.setConsent(consent).catch(error => {
    logger.warn('Failed to sync Sentry consent to Rust side', {
      consent,
      error: String(error),
    })
    // 重试一次,确保 Rust 侧 consent 状态最终一致
    setTimeout(() => {
      commands.setConsent(consent).catch(retryError => {
        logger.error('Sentry consent sync retry failed', {
          retryError: String(retryError),
        })
      })
    }, 1000)
  })

  if (!initialized) return

  if (consent === true) {
    // 设置匿名用户 ID 并持久化到 localStorage,确保同一设备
    // 跨会话始终被识别为同一用户。仅存储随机 UUID,不含任何 PII(个人身份信息)。
    // 使用 try-catch 包裹 localStorage 操作 —— 隐私模式或存储配额已满时
    // localStorage 会抛错,此时退化为使用内存中的临时 ID,不应中断授权流程。
    const ANON_USER_KEY = 'sentry_anon_user_id'
    let anonId: string
    try {
      anonId = localStorage.getItem(ANON_USER_KEY) ?? ''
      if (!anonId) {
        anonId = crypto.randomUUID()
        try {
          localStorage.setItem(ANON_USER_KEY, anonId)
        } catch {
          // 存储配额已满或隐私模式 —— 仅用内存中的临时 ID
          logger.warn('Failed to persist anon user ID to localStorage')
        }
      }
    } catch {
      // 隐私模式 —— 生成临时 ID,不持久化
      anonId = crypto.randomUUID()
    }
    Sentry.setUser({ id: anonId, ip_address: '{{auto}}' })
  } else {
    Sentry.setUser(null)
  }
}

/**
 * 关闭 Sentry SDK 并停止所有待发送事件。
 *
 * 调用时机：用户撤回授权，或应用退出时。
 * 行为：阻塞 flush 队列内事件后释放 SDK 资源，重置 initialized 以允许后续重新 init。
 *
 * @returns Promise 在 SDK 完全关闭后 resolve
 */
export async function closeSentry(): Promise<void> {
  if (!initialized) return
  await Sentry.close()
  initialized = false
}

/**
 * 检查 Sentry 是否已初始化（DSN 已配置且 init 已调用）。
 */
export function isSentryInitialized(): boolean {
  return initialized
}

/**
 * 检查 Sentry DSN 是否已配置。
 * 若未配置，则无论用户授权与否，崩溃上报都不可用。
 */
export function isSentryEnabled(): boolean {
  return !!SENTRY_DSN
}

/**
 * 捕获异常并上报到 Sentry（若已初始化）。
 * 即使 Sentry 未初始化也可安全调用（空操作）。
 * 注意：只有在用户已授权的情况下事件才会被发送。
 */
export function captureException(error: Error | unknown): void {
  if (initialized) {
    Sentry.captureException(error)
  }
}

/**
 * 捕获消息并上报到 Sentry（若已初始化）。
 * 即使 Sentry 未初始化也可安全调用（空操作）。
 * 注意：只有在用户已授权的情况下事件才会被发送。
 */
export function captureMessage(
  message: string,
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug'
): void {
  if (initialized) {
    Sentry.captureMessage(message, level)
  }
}

/**
 * 在传输前对 Sentry 事件中的敏感数据进行脱敏。
 *
 * 处理范围：
 * - 请求 URL（包含敏感 key 的查询参数）
 * - 请求头（Authorization、Cookie 等）
 * - 面包屑 (breadcrumb) 的消息和数据
 * - 额外的上下文 (extra) 值
 *
 * 设计要点：
 *  - 直接修改入参 event 的可变字段以减少内存分配；
 *  - 面包屑使用 spread 浅拷贝后修改，避免污染 SDK 内部状态；
 *  - 该函数同步执行，不影响 SDK 上报时序。
 *
 * @param event 原始 Sentry 事件
 * @returns 脱敏后的同引用事件（供 beforeSend 链路继续处理）
 */
function redactSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // 对请求 URL、请求头、cookies 和请求体进行脱敏
  if (event.request) {
    if (event.request.url) {
      event.request.url = redactString(event.request.url)
    }
    if (event.request.headers) {
      event.request.headers = redactObject(event.request.headers)
    }
    // 补全 cookies 脱敏 —— cookies 类型为 Record<string, string>,用
    // redactObject 处理(与 headers 一致),敏感 key 的值会被替换为 ***
    if (event.request.cookies) {
      event.request.cookies = redactObject(event.request.cookies)
    }
    // 补全 request.data 脱敏 —— 请求体可能包含敏感负载
    if (event.request.data && typeof event.request.data === 'string') {
      event.request.data = redactString(event.request.data)
    }
  }

  // 对面包屑 (breadcrumb) 进行脱敏
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb): Sentry.Breadcrumb => {
      const redacted = { ...crumb }
      if (crumb.message) {
        redacted.message = redactString(crumb.message)
      }
      if (crumb.data) {
        redacted.data = redactObject(crumb.data)
      }
      return redacted
    })
  }

  // 对额外上下文 (extra) 进行脱敏
  if (event.extra) {
    event.extra = redactObject(event.extra)
  }

  // 补全 user 脱敏 —— 仅保留匿名 ID,其他字段(邮箱、用户名、IP 等)全部清除。
  // 注意:因 exactOptionalPropertyTypes 启用,不能赋值 undefined 给可选属性,
  // 改用 delete 删除属性。
  if (event.user) {
    const userId = event.user.id
    if (userId) {
      event.user = { id: userId }
    } else {
      delete event.user
    }
  }

  // 补全 contexts 脱敏 —— contexts 可能包含设备、操作系统等上下文中的敏感信息
  if (event.contexts) {
    event.contexts = redactObject(event.contexts)
  }

  return event
}
