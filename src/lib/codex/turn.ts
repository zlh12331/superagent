/**
 * Codex API — Turn 域
 *
 * Turn 管理：启动、转向、中断。
 *
 * 后端命令已实现（3 个 Tauri command）：
 * - turn_start — 启动新轮次
 * - turn_steer — 在当前轮次中追加用户输入（转向）
 * - turn/interrupt — 中断正在进行的轮次
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — Turn, Message 类型
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  TurnStartArgs,
  TurnSteerArgs,
  TurnInterruptArgs,
  ThreadReadArgs,
} from '@/lib/bindings'
import type { Turn, TurnId, ThreadId, Message, TurnStatus } from './types'
import type { ThreadReadResponse } from './thread'
import { threadItemsToMessages, type RawThreadItem } from './thread-items'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的数据与流式事件发射器
import {
  getMockData,
  shouldFail,
  getMockError,
  createMockTurn,
  simulateTurn,
} from './mock'

// ---------------------------------------------------------------------------
// Tauri 响应类型与适配器（master 分支的真实集成）
// ---------------------------------------------------------------------------

/**
 * codex-rs UserInput 的 JSON 结构（前端构造后 JSON.stringify 传入）。
 *
 * specta 无法处理 serde_json::Value（递归类型触发 BigInt 禁令），
 * 因此 TurnStartArgs.input / TurnSteerArgs.input 为 JSON 字符串。
 * 前端必须 `JSON.stringify(inputArray)` 后再传入命令。
 *
 * @see codex-rs/app-server-protocol/src/protocol/v2/turn.rs — UserInput enum
 */
interface UserInputText {
  /** 变体标签，固定为 "text"（对应 Rust enum 的 tag） */
  type: 'text'
  /** 用户输入的文本内容 */
  text: string
  /** UI 定义的文本元素范围（默认空数组） */
  textElements: unknown[]
}

/** turn/start 响应的 JSON 结构（简化版） */
interface TurnStartResponse {
  turn: {
    id: string
    status: string
    /** Unix 时间戳（秒），后端使用秒，前端使用毫秒 */
    startedAt?: number | null
    /** Unix 时间戳（秒） */
    completedAt?: number | null
  }
}

/** turn/steer 响应的 JSON 结构 */
interface TurnSteerResponse {
  turnId: string
}

/**
 * 将纯文本消息构造为 codex-rs UserInput 数组并序列化为 JSON 字符串。
 *
 * codex-rs 的 UserInput 使用 `#[serde(tag = "type")]` 内部标签序列化，
 * Text 变体序列化为 `{ "type": "text", "text": "...", "textElements": [] }`。
 * 前端构造数组后 `JSON.stringify` 即可。
 *
 * @param message — 用户输入的文本消息
 * @returns Vec<UserInput> 的 JSON 字符串
 */
function buildUserInputJson(message: string): string {
  const input: UserInputText[] = [
    {
      type: 'text',
      text: message,
      textElements: [],
    },
  ]
  return JSON.stringify(input)
}

/**
 * 将 codex-rs 的 TurnStatus 映射为前端 TurnStatus。
 *
 * codex-rs 使用 camelCase（completed / interrupted / failed / inProgress），
 * 前端类型使用不同的命名（completed / cancelled / failed / running）。
 *
 * @param raw — 后端返回的状态字符串
 * @returns 前端 TurnStatus
 */
function adaptTurnStatus(raw: string): TurnStatus {
  switch (raw) {
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'inProgress':
      return 'running'
    default:
      return 'pending'
  }
}

/**
 * 将后端返回的 turn 对象转换为前端 Turn 类型。
 *
 * codex-rs 的时间戳是 Unix 秒，前端使用 Unix 毫秒时间戳，
 * 适配时需乘以 1000。
 *
 * @param raw — 后端 turn 对象
 * @param threadId — 线程 ID（后端 turn 对象不含此字段，由请求参数传入）
 * @returns 前端 Turn 类型
 */
function adaptTurn(raw: TurnStartResponse['turn'], threadId: ThreadId): Turn {
  return {
    id: raw.id,
    threadId,
    status: adaptTurnStatus(raw.status),
    // codex-rs 时间戳为 Unix 秒，前端使用毫秒
    startedAt: raw.startedAt ? raw.startedAt * 1000 : Date.now(),
    completedAt: raw.completedAt ? raw.completedAt * 1000 : null,
  }
}

// ---------------------------------------------------------------------------
// API 函数
// ---------------------------------------------------------------------------

/**
 * 启动新的会话轮次（发送用户消息到 codex）。
 *
 * Tauri 模式调用 `turn/start` 命令，将用户消息构造为 UserInput JSON 字符串后传入，
 * 浏览器模式返回 mock 数据。
 *
 * @param threadId — 线程 ID
 * @param message — 用户消息文本
 * @param model — 可选，覆盖本轮使用的模型（为空时使用线程默认模型）
 * @param cwd — 可选，覆盖本轮的工作目录（为空时使用线程默认工作目录）
 * @returns 新创建的 Turn 对象
 */
export async function startTurn(
  threadId: ThreadId,
  message: string,
  model?: string | null,
  cwd?: string | null
): Promise<Turn> {
  if (isTauri()) {
    const args: TurnStartArgs = {
      threadId,
      input: buildUserInputJson(message),
      model: model ?? null,
      cwd: cwd ?? null,
    }
    const result = await commands.turnStart(args)
    if (result.status === 'error') {
      throw new Error(`turn/start failed: ${result.error.message}`)
    }
    const parsed: TurnStartResponse = JSON.parse(result.data)
    return adaptTurn(parsed.turn, threadId)
  }

  // 浏览器开发模式 — 构造 mock Turn 并模拟流式回复事件序列
  const turn = createMockTurn(threadId)
  simulateTurn(threadId, turn.id, message)
  return turn
}

/**
 * 在当前轮次中追加用户输入（转向）。
 *
 * Tauri 模式调用 `turn/steer` 命令，在正在进行的轮次中注入新的用户输入。
 * `expectedTurnId` 必须与当前活跃的 turn ID 匹配，否则请求失败。
 * 浏览器模式返回 mock turn ID。
 *
 * @param threadId — 线程 ID
 * @param message — 追加的用户消息文本
 * @param expectedTurnId — 预期的当前活跃 turn ID（不匹配时请求失败）
 * @returns 新的 turn ID
 */
export async function steerTurn(
  threadId: ThreadId,
  message: string,
  expectedTurnId: TurnId
): Promise<TurnId> {
  if (isTauri()) {
    const args: TurnSteerArgs = {
      threadId,
      input: buildUserInputJson(message),
      expectedTurnId,
    }
    const result = await commands.turnSteer(args)
    if (result.status === 'error') {
      throw new Error(`turn/steer failed: ${result.error.message}`)
    }
    const parsed: TurnSteerResponse = JSON.parse(result.data)
    return parsed.turnId
  }

  // 浏览器开发模式 — 返回 mock turn ID
  return `turn-${Date.now()}`
}

/**
 * 中断正在进行的轮次。
 *
 * Tauri 模式调用 `turn/interrupt` 命令，停止正在进行的轮次，
 * 浏览器模式为 no-op。
 *
 * @param threadId — 线程 ID
 * @param turnId — 要中断的轮次 ID
 */
export async function cancelTurn(
  threadId: ThreadId,
  turnId: TurnId
): Promise<void> {
  if (isTauri()) {
    const args: TurnInterruptArgs = { threadId, turnId }
    const result = await commands.turnInterrupt(args)
    if (result.status === 'error') {
      throw new Error(`turn/interrupt failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 列出线程中的消息。
 *
 * 调用 `thread/read(includeTurns=true)` 获取含 turn 历史的线程数据，
 * 然后通过 `threadItemsToMessages` 适配层将所有 turn 的 items 展平为 Message 数组。
 *
 * 这是获取消息历史的正确数据源：
 * 1. `thread/read` 返回 `thread.turns[]`
 * 2. 每个 turn 包含 `items[]`（ThreadItem 枚举数组）
 * 3. 适配层将 18 种 ThreadItem 变体映射为前端 Message 类型
 *
 * 浏览器模式返回 mock 数据。
 *
 * @param threadId — 线程 ID
 * @returns 消息列表（按 turn 顺序排列）
 */
export async function listMessages(threadId: ThreadId): Promise<Message[]> {
  if (isTauri()) {
    const args: ThreadReadArgs = {
      threadId,
      includeTurns: true,
    }
    const result = await commands.threadRead(args)
    if (result.status === 'error') {
      throw new Error(`thread/read failed: ${result.error.message}`)
    }
    const parsed: ThreadReadResponse = JSON.parse(result.data)
    // 展平所有 turn 的 items，按顺序转为 Message
    const turns = parsed.thread.turns ?? []
    const allItems: RawThreadItem[] = []
    for (const turn of turns) {
      if (turn.items) {
        allItems.push(...turn.items)
      }
    }
    return threadItemsToMessages(allItems)
  }

  // 浏览器开发模式 — error 场景按配置抛错，否则返回 mock 消息列表
  if (shouldFail('listMessages')) {
    throw getMockError('listMessages')
  }
  return getMockData().messages
}

/**
 * 获取轮次状态。
 *
 * 后端尚未提供专门的 get-turn-status 命令，暂保持 mock 数据。
 * 实际状态可通过事件流（turn:status 事件）或 thread/read 获取。
 *
 * @param turnId — 轮次 ID
 * @returns 轮次状态
 */
export async function getTurnStatus(_turnId: TurnId): Promise<Turn['status']> {
  if (isTauri()) {
    // TODO[task8-remaining]: 后端实现 get-turn-status 命令后替换为真实调用
    return 'completed'
  }
  return 'completed'
}
