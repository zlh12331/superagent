/**
 * Codex API — Account 域
 *
 * 账户管理：登录、登出、获取账户信息。
 *
 * 后端命令已实现（4 个 Tauri command）：
 * - login_account — 启动账户登录流程（支持 apiKey / chatgpt / chatgptDeviceCode）
 * - cancel_login_account — 取消正在进行的登录流程
 * - logout_account — 登出当前账户
 * - get_account — 获取当前账户信息
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — AccountInfo 类型
 */

import type { UnlistenFn } from '@tauri-apps/api/event'
import { commands } from '@/lib/tauri-bindings'
import type {
  LoginAccountArgs_Deserialize,
  CancelLoginAccountArgs,
  LogoutAccountArgs,
  GetAccountArgs_Deserialize,
} from '@/lib/bindings'
import type { AccountInfo } from './types'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'
// 集中式 mock 模块 — 浏览器开发模式的数据源、错误场景与统一事件监听
import { getMockData, shouldFail, getMockError, universalListen } from './mock'

/**
 * 浏览器模式下登录函数返回的 fallback 账户。
 *
 * getAccount 在 boundary 场景下返回 null（模拟未登录），
 * 但 loginWithChatGPT / loginWithApiKey 应返回有效数据（模拟登录成功），
 * 因此使用此 fallback 而非 getMockData().account。
 */
const FALLBACK_LOGIN_ACCOUNT: AccountInfo = {
  email: 'dev@codex.dev',
  plan: 'ChatGPT Plus · Pro',
  authMode: 'chatgpt',
}

// ---------------------------------------------------------------------------
// Tauri 响应类型与适配器
// ---------------------------------------------------------------------------

/** loginAccount 响应的 JSON 结构 */
interface LoginAccountResponse {
  /** 登录会话 ID（chatgpt / chatgptDeviceCode 模式返回） */
  loginId?: string
  /** OAuth 授权 URL（chatgpt 模式返回，前端在浏览器中打开） */
  authUrl?: string
  /** 设备码验证 URL（chatgptDeviceCode 模式返回） */
  verificationUrl?: string
  /** 用户码（chatgptDeviceCode 模式返回） */
  userCode?: string
  /** 设备码过期时间（秒，chatgptDeviceCode 模式返回） */
  expiresIn?: number
  /** 轮询间隔（秒，chatgptDeviceCode 模式返回） */
  interval?: number
}

/** getAccount 响应的 JSON 结构 */
interface GetAccountResponse {
  /** 账户信息（未登录时为 null） */
  account: {
    email: string
    plan: string
    authMode: string
  } | null
  /** 是否需要 OpenAI 认证 */
  needsOpenAIAuth?: boolean
}

/**
 * 当前登录会话 ID（模块级状态变量）。
 *
 * `startLogin` / `loginWithChatGPT` 调用后端 `loginAccount` 时保存返回的 loginId，
 * `cancelLogin` 在未显式传入 loginId 时使用此值。
 * `logout` 或 `cancelLogin` 成功后清空。
 */
let currentLoginId: string | null = null

/**
 * 异步登录流程（chatgpt / chatgptDeviceCode）的超时时间（毫秒）。
 *
 * 超时后自动调用 cancelLogin 取消挂起的登录会话，避免 currentLoginId
 * 长期占用导致后续登录被误取消或会话资源泄漏。
 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

/**
 * 将前端 LoginType 转换为后端 loginType 字符串。
 *
 * 前端使用 `'api_key'`（下划线），后端使用 `'apiKey'`（驼峰）。
 */
function toBackendLoginType(loginType: LoginType): string {
  return loginType === 'api_key' ? 'apiKey' : loginType
}

// ---------------------------------------------------------------------------
// API 函数
// ---------------------------------------------------------------------------

/**
 * 获取当前账户信息。
 *
 * Tauri 模式调用 `account/read` 命令，
 * 浏览器模式返回 mock 数据。
 *
 * @returns 账户信息，或 null（未登录时）
 */
export async function getAccount(): Promise<AccountInfo | null> {
  if (isTauri()) {
    const args: GetAccountArgs_Deserialize = { refreshToken: null }
    const result = await commands.getAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/read failed: ${result.error.message}`)
    }
    const parsed: GetAccountResponse = JSON.parse(result.data)
    if (!parsed.account) return null
    return {
      email: parsed.account.email,
      plan: parsed.account.plan,
      authMode: parsed.account.authMode as AccountInfo['authMode'],
    }
  }

  // 浏览器开发模式 — error 场景按配置抛错，否则返回 mock 账户（可能为 null）
  if (shouldFail('getAccount')) {
    throw getMockError('getAccount')
  }
  return getMockData().account
}

/**
 * 使用 ChatGPT OAuth 登录。
 *
 * Tauri 模式调用 `account/login/start` 命令（loginType = 'chatgpt'），
 * 浏览器模式返回 mock 数据。
 *
 * 注意：ChatGPT OAuth 流程是异步的，登录完成后通过 `onLoginCompleted`
 * 事件通知。此函数仅启动登录流程，**不返回真实账户信息**：
 * - Tauri 模式返回 null，调用方应监听 onLoginCompleted 事件获取账户
 * - 浏览器 mock 模式返回 fallback 账户（仅供前端独立调试）
 *
 * @returns Tauri 模式返回 null（等待事件）；浏览器模式返回 mock 账户
 */
export async function loginWithChatGPT(): Promise<AccountInfo | null> {
  if (isTauri()) {
    const args: LoginAccountArgs_Deserialize = {
      loginType: 'chatgpt',
      apiKey: null,
    }
    const result = await commands.loginAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/login/start failed: ${result.error.message}`)
    }
    const parsed: LoginAccountResponse = JSON.parse(result.data)
    // 保存 loginId 供 cancelLogin 使用
    currentLoginId = parsed.loginId ?? null
    // OAuth 流程是异步的，真实账户信息通过 onLoginCompleted 事件返回，此处返回 null
    return null
  }
  return FALLBACK_LOGIN_ACCOUNT
}

/**
 * 使用 API Key 登录。
 *
 * Tauri 模式调用 `account/login/start` 命令（loginType = 'apiKey'），
 * 登录成功后调用 `getAccount()` 获取实际账户信息。
 * 浏览器模式返回 mock 数据。
 *
 * @param apiKey — OpenAI API Key
 * @returns 账户信息
 */
export async function loginWithApiKey(apiKey: string): Promise<AccountInfo> {
  if (isTauri()) {
    const args: LoginAccountArgs_Deserialize = {
      loginType: 'apiKey',
      apiKey,
    }
    const result = await commands.loginAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/login/start failed: ${result.error.message}`)
    }
    // apiKey 登录是同步的，登录后直接读取账户信息
    return (await getAccount()) ?? { ...FALLBACK_LOGIN_ACCOUNT, authMode: 'api_key' }
  }
  return { ...FALLBACK_LOGIN_ACCOUNT, authMode: 'api_key' }
}

/**
 * 登出当前账户。
 *
 * Tauri 模式调用 `account/logout` 命令，
 * 浏览器模式为 no-op。
 */
export async function logout(): Promise<void> {
  if (isTauri()) {
    // LogoutAccountArgs 为空对象（Record<string, never>）
    const args: LogoutAccountArgs = {}
    const result = await commands.logoutAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/logout failed: ${result.error.message}`)
    }
    // 清空当前登录会话状态
    currentLoginId = null
    return
  }

  // 浏览器开发模式 — no-op
}

// ─── Task 19: 登录流程扩展 ─────────────────────────────────────
// 以下类型与函数支持三种登录方式（API Key / ChatGPT OAuth / 设备码），
// 并提供事件监听以响应登录完成与账户状态变化。

/** 登录方式 */
export type LoginType = 'api_key' | 'chatgpt' | 'chatgptDeviceCode'

/** 登录状态 */
export interface AuthStatus {
  authenticated: boolean
  provider: string | null
  accountLabel: string | null
}

/** 设备码信息（chatgptDeviceCode 登录方式） */
export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

/** 登录启动结果 */
export interface LoginStartResult {
  status: 'pending' | 'completed' | 'error'
  provider: LoginType
  /** OAuth 授权 URL（chatgpt 模式返回，前端在浏览器中打开） */
  authUrl?: string | undefined
  /** 设备码信息（chatgptDeviceCode 模式返回） */
  deviceCode?: DeviceCodeInfo | undefined
  /** 登录会话 ID（用于 cancelLogin，chatgpt/chatgptDeviceCode 模式返回） */
  loginId?: string | undefined
}

/**
 * 启动登录流程。
 *
 * Tauri 模式调用 `account/login/start` 命令，根据登录类型启动不同的认证流程：
 * - api_key: 直接传入 apiKey 完成登录（同步，status = 'completed'）
 * - chatgpt: 触发 OAuth 浏览器跳转，通过 deep-link 回调完成（异步，status = 'pending'）
 * - chatgptDeviceCode: 返回设备码，用户在浏览器中验证（异步，status = 'pending'）
 *
 * 浏览器模式返回 pending 状态的 mock 数据。
 *
 * @param loginType — 登录方式
 * @param apiKey — API Key（仅 api_key 模式需要）
 * @returns 登录启动结果
 */
export async function startLogin(
  loginType: LoginType,
  apiKey?: string
): Promise<LoginStartResult> {
  if (isTauri()) {
    // Bug 8: 若已有进行中的登录会话，先取消旧的，避免 currentLoginId 被新值覆盖
    // 导致旧流程泄漏或被后续 cancelLogin 误伤。
    if (currentLoginId) {
      logger.warn('Cancelling previous login before starting new one', {
        oldLoginId: currentLoginId,
      })
      await cancelLogin(currentLoginId).catch(() => {
        /* 取消旧登录失败不阻塞新登录，继续往下执行 */
      })
    }

    const args: LoginAccountArgs_Deserialize = {
      loginType: toBackendLoginType(loginType),
      apiKey: apiKey ?? null,
    }
    const result = await commands.loginAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/login/start failed: ${result.error.message}`)
    }
    const parsed: LoginAccountResponse = JSON.parse(result.data)

    // 保存 loginId 供 cancelLogin 使用
    const loginId = parsed.loginId ?? null
    currentLoginId = loginId

    // Bug 7: 异步登录流程（chatgpt / chatgptDeviceCode）启动超时保护。
    // 超时后若本次会话仍为当前会话（未被新登录替换），则自动取消，避免长期挂起。
    // api_key 为同步登录、无 loginId，不启动超时定时器。
    if (loginId) {
      setTimeout(() => {
        if (currentLoginId === loginId) {
          logger.warn('Login timed out, auto cancelling', { loginId })
          cancelLogin(loginId).catch(() => {
            /* 忽略超时取消失败 */
          })
        }
      }, LOGIN_TIMEOUT_MS)
    }

    // 根据登录类型构造返回结果
    if (loginType === 'api_key') {
      // apiKey 登录是同步的，立即完成
      return { status: 'completed', provider: loginType }
    }

    if (loginType === 'chatgpt') {
      // chatgpt OAuth 流程：返回 authUrl 供前端打开浏览器
      return {
        status: 'pending',
        provider: loginType,
        authUrl: parsed.authUrl,
        loginId: parsed.loginId,
      }
    }

    // chatgptDeviceCode 设备码流程：返回设备码信息
    return {
      status: 'pending',
      provider: loginType,
      loginId: parsed.loginId,
      deviceCode: {
        userCode: parsed.userCode ?? '',
        // 后端返回 verificationUrl，前端使用 verificationUri
        verificationUri: parsed.verificationUrl ?? '',
        expiresIn: parsed.expiresIn ?? 0,
        interval: parsed.interval ?? 0,
      },
    }
  }

  // 浏览器 mock: 模拟异步登录
  return { status: 'pending', provider: loginType }
}

/**
 * 取消正在进行的登录流程。
 *
 * Tauri 模式调用 `account/login/cancel` 命令，
 * 浏览器模式为 no-op。
 *
 * @param loginId — 要取消的登录会话 ID（为空时使用 startLogin 保存的 currentLoginId）
 */
export async function cancelLogin(loginId?: string): Promise<void> {
  if (isTauri()) {
    const id = loginId ?? currentLoginId
    if (!id) {
      // 没有活跃的登录会话，无需取消
      return
    }
    const args: CancelLoginAccountArgs = { loginId: id }
    const result = await commands.cancelLoginAccount(args)
    if (result.status === 'error') {
      throw new Error(`account/login/cancel failed: ${result.error.message}`)
    }
    // 清空当前登录会话状态
    currentLoginId = null
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 监听登录完成事件（account/login/completed）。
 *
 * Tauri 环境下注册事件监听器；浏览器 / 测试环境下返回空 unlisten，
 * 调用方可安全地在 cleanup 中直接调用返回的函数。
 */
export async function onLoginCompleted(
  callback: (event: { account: string; provider: string }) => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen<{ account: string; provider: string }>(
    'account/login/completed',
    callback
  )
}

/**
 * 监听账户状态变化（account/updated）。
 *
 * Tauri 环境下注册事件监听器；浏览器 / 测试环境下返回空 unlisten。
 */
export async function onAccountUpdated(
  callback: (status: AuthStatus) => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen<AuthStatus>('account/updated', callback)
}
