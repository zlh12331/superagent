/**
 * Codex API — Thread 域
 *
 * 线程管理：启动、列出、读取、取消订阅。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * 后端命令已在 Task 8 实现（4 个 Tauri command）：
 * - thread_start — 创建新线程
 * - thread_list — 列出线程
 * - thread_read — 读取线程详情
 * - thread_unsubscribe — 取消订阅线程事件
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — Thread 类型定义
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  // 生命周期（4 + 7 = 11）
  ThreadStartArgs,
  ThreadListArgs,
  ThreadReadArgs,
  ThreadUnsubscribeArgs,
  ThreadResumeArgs,
  ThreadForkArgs,
  ThreadArchiveArgs,
  ThreadUnarchiveArgs,
  ThreadDeleteArgs,
  ThreadRollbackArgs,
  ThreadSetNameArgs,
  // 元数据 + Goal（4）
  ThreadMetadataUpdateArgs,
  ThreadGoalSetArgs,
  ThreadGoalGetArgs,
  ThreadGoalClearArgs,
  // 列表查询（5）
  ThreadLoadedListArgs,
  ThreadSearchArgs,
  ThreadTurnsListArgs,
  ThreadItemsListArgs,
  ThreadInjectItemsArgs,
  // 操作（3）
  ThreadCompactStartArgs,
  ThreadShellCommandArgs,
  ThreadApproveGuardianDeniedActionArgs,
  // 实验性功能（4）
  ThreadIncrementElicitationArgs,
  ThreadDecrementElicitationArgs,
  ThreadSettingsUpdateArgs,
  ThreadMemoryModeSetArgs,
  // 后台终端（3）
  ThreadBackgroundTerminalsCleanArgs,
  ThreadBackgroundTerminalsListArgs,
  ThreadBackgroundTerminalsTerminateArgs,
  // 实时语音/文本对话（6）
  ThreadRealtimeStartArgs,
  ThreadRealtimeAppendAudioArgs,
  ThreadRealtimeAppendTextArgs,
  ThreadRealtimeAppendSpeechArgs,
  ThreadRealtimeStopArgs,
  ThreadRealtimeListVoicesArgs,
} from '@/lib/bindings'
import type { Thread, ThreadId, ThreadMetadata, Message } from './types'
import type { RawTurn, RawThreadItem } from './thread-items'
import { threadItemsToMessages } from './thread-items'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的数据源、错误场景与工厂函数
import {
  getMockData,
  shouldFail,
  getMockError,
  createMockThread,
  forkMockThread,
} from './mock'

// ---------------------------------------------------------------------------
// Mock 数据基础设施（浏览器开发模式使用）
// ---------------------------------------------------------------------------

/** Mock 数据用的时间常量 */
const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000

/** Thread 的默认值（除 id 和 title 外的所有字段） */
const DEFAULT_THREAD: Omit<Thread, 'id' | 'title'> = {
  createdAt: NOW - HOUR,
  updatedAt: NOW - MIN,
  archived: false,
  archivedAt: null,
  appId: null,
  cwd: null,
  forkedFromThreadId: null,
  model: 'gpt-5',
  modelProvider: 'openai',
  metadata: { folder: null, msgs: 0, title: null, pinned: false },
}

// ---------------------------------------------------------------------------
// Tauri 响应类型（对应 codex-rs app-server-protocol 中的结构体）
// ---------------------------------------------------------------------------

/**
 * 后端返回的线程原始对象（对应 codex-rs app-server-protocol 的 Thread）。
 *
 * 除 id 外所有字段可选，因为不同接口返回的字段集合可能不同：
 * - thread/start 返回的 thread 对象字段较少（model 和 cwd 在响应顶层）
 * - thread/list 和 thread/read 返回完整的 thread 对象
 *
 * 时间字段为 ISO 8601 字符串，由 adaptThread 转换为 Unix 毫秒时间戳。
 * 注意：可选字段（?）在 exactOptionalPropertyTypes 约束下不能显式赋 undefined，
 * 但读取时类型为 `T | undefined`，可用 ?? 运算符提供默认值。
 */
interface RawThread {
  id: string
  /** 线程标题（未返回时 adaptThread 使用 'Untitled'） */
  title?: string
  /** 创建时间（ISO 8601 字符串） */
  createdAt?: string
  /** 更新时间（ISO 8601 字符串） */
  updatedAt?: string
  /** 是否已归档（未返回时默认 false） */
  archived?: boolean
  /** 归档时间（ISO 字符串或 null） */
  archivedAt?: string | null
  /** 关联的 App ID */
  appId?: string | null
  /** 工作目录路径 */
  cwd?: string | null
  /** 分叉来源线程 ID */
  forkedFromThreadId?: string | null
  /** 模型名称（如 gpt-5） */
  model?: string
  /** 模型提供方（如 openai） */
  modelProvider?: string
  /** 线程元数据 */
  metadata?: {
    folder?: string | null
    msgs?: number
    title?: string | null
    pinned?: boolean
  }
  /**
   * Turn 历史（仅 `thread/read(includeTurns=true)` 时填充）。
   *
   * 每个 turn 的 `items` 字段包含 ThreadItem 数组，
   * 由 `threadItemsToMessages` 适配器转换为前端 Message 数组。
   */
  turns?: RawTurn[]
}

/** thread/start 响应的 JSON 结构 */
interface ThreadStartResponse {
  thread: RawThread
  model: string
  cwd: string
}

/** thread/list 响应的 JSON 结构 */
interface ThreadListResponse {
  threads: RawThread[]
  nextCursor?: string | null
}

/** thread/read 响应的 JSON 结构 */
export interface ThreadReadResponse {
  thread: RawThread
}

/**
 * 将后端返回的原始线程对象转换为前端 Thread 类型。
 *
 * codex-rs 的时间戳是 ISO 8601 字符串，前端使用 Unix 毫秒时间戳。
 * 使用 DEFAULT_THREAD 填充后端未返回的字段（如 appId、forkedFromThreadId 等），
 * 再用后端实际返回的值覆盖。
 *
 * 关键修复：archived 不再硬编码为 false，而是使用后端返回的值，
 * 避免 listThreads(true) 过滤归档线程时永远返回空数组的 bug。
 */
function adaptThread(raw: RawThread): Thread {
  return {
    ...DEFAULT_THREAD,
    id: raw.id,
    title: raw.title ?? 'Untitled',
    createdAt: raw.createdAt ? Date.parse(raw.createdAt) : Date.now(),
    updatedAt: raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now(),
    // 使用后端返回的 archived 状态，未返回时默认为 false
    archived: raw.archived ?? false,
    // 使用后端返回的 archivedAt（ISO 字符串），未返回或为 null 时默认为 null
    archivedAt: raw.archivedAt ? Date.parse(raw.archivedAt) : null,
    // 使用后端返回的 appId，未返回或为 null 时默认为 null
    appId: raw.appId ?? null,
    // 使用后端返回的 cwd，未返回或为 null 时默认为 null
    cwd: raw.cwd ?? null,
    // 使用后端返回的 forkedFromThreadId，未返回或为 null 时默认为 null
    forkedFromThreadId: raw.forkedFromThreadId ?? null,
    // 使用后端返回的 model，未返回时默认为 'gpt-5'
    model: raw.model ?? 'gpt-5',
    // 使用后端返回的 modelProvider，未返回时默认为 'openai'
    modelProvider: raw.modelProvider ?? 'openai',
    // 使用后端返回的 metadata，逐字段提供默认值避免引用共享
    metadata: {
      folder: raw.metadata?.folder ?? null,
      msgs: raw.metadata?.msgs ?? 0,
      title: raw.metadata?.title ?? null,
      pinned: raw.metadata?.pinned ?? false,
    },
  }
}

// ---------------------------------------------------------------------------
// API 函数 — 已对接真实 Tauri 命令
// ---------------------------------------------------------------------------

/**
 * 创建新线程。
 *
 * 调用 `thread/start` 命令，传入工作目录和可选元数据。
 * 浏览器模式返回 mock 数据。
 *
 * @param cwd — 工作目录路径，为空使用主目录
 * @param metadata — 可选的线程元数据（如 title、folder）
 * @returns 新创建的线程
 */
export async function createThread(
  cwd: string | null,
  metadata?: Partial<ThreadMetadata>
): Promise<Thread> {
  if (isTauri()) {
    const args: ThreadStartArgs = {
      model: null,
      modelProvider: null,
      cwd: cwd ?? null,
    }
    const result = await commands.threadStart(args)
    if (result.status === 'error') {
      throw new Error(`thread/start failed: ${result.error.message}`)
    }
    const parsed: ThreadStartResponse = JSON.parse(result.data)
    return adaptThread(parsed.thread)
  }

  // 浏览器开发模式 — 构造 mock 线程
  return createMockThread(
    `thread-${Date.now()}`,
    metadata?.title,
    cwd,
    metadata
  )
}

/**
 * 列出所有线程。
 *
 * 调用 `thread/list` 命令获取线程列表，支持按 archived 状态过滤。
 * 浏览器模式返回 mock 数据。
 *
 * @param archived — 可选的归档过滤（true=仅归档，false=仅最近，undefined=全部）
 * @returns 线程数组
 */
export async function listThreads(archived?: boolean): Promise<Thread[]> {
  if (isTauri()) {
    const args: ThreadListArgs = {
      cursor: null,
      limit: null,
    }
    const result = await commands.threadList(args)
    if (result.status === 'error') {
      throw new Error(`thread/list failed: ${result.error.message}`)
    }
    const parsed: ThreadListResponse = JSON.parse(result.data)
    let threads = parsed.threads.map(adaptThread)
    // 后端不支持 archived 过滤，前端按需过滤
    if (archived !== undefined) {
      threads = threads.filter(t => t.archived === archived)
    }
    return threads
  }

  // 浏览器开发模式 — error 场景按配置抛错，否则返回 mock 数据
  if (shouldFail('listThreads')) {
    throw getMockError('listThreads')
  }
  if (archived !== undefined) {
    return getMockData().threads.filter(t => t.archived === archived)
  }
  return getMockData().threads
}

/**
 * 读取线程详情（含可选的 turn 历史）。
 *
 * 调用 `thread/read` 命令。线程不存在时返回 null。
 * 浏览器模式从 mock 查找。
 *
 * @param threadId — 线程 ID
 * @param includeTurns — 是否包含 turn 历史（默认 false）
 * @returns 线程信息，或 null（不存在时）
 */
export async function getThread(
  threadId: ThreadId,
  includeTurns?: boolean
): Promise<Thread | null> {
  if (isTauri()) {
    const args: ThreadReadArgs = {
      threadId,
      includeTurns: includeTurns ?? false,
    }
    const result = await commands.threadRead(args)
    if (result.status === 'error') {
      // NotFound 表示线程不存在，返回 null 而非抛错
      if (result.error.kind === 'NotFound') {
        return null
      }
      throw new Error(`thread/read failed: ${result.error.message}`)
    }
    const parsed: ThreadReadResponse = JSON.parse(result.data)
    return adaptThread(parsed.thread)
  }

  // 浏览器开发模式 — 从 mock 查找
  return getMockData().threads.find(t => t.id === threadId) ?? null
}

/**
 * 取消订阅线程事件。
 *
 * 调用 `thread/unsubscribe` 命令，停止接收指定线程的 ServerNotification。
 * 通常在关闭线程标签页或退出时调用。
 *
 * @param threadId — 要取消订阅的线程 ID
 */
export async function unsubscribeThread(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadUnsubscribeArgs = { threadId }
    const result = await commands.threadUnsubscribe(args)
    if (result.status === 'error') {
      throw new Error(`thread/unsubscribe failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

// ============================================================================
// 以下函数已对接真实 Tauri 命令（后端 36 个 thread 命令已全量暴露）
// ============================================================================

/**
 * 删除线程。
 *
 * 调用 `thread/delete` 命令永久删除指定线程。
 * 浏览器模式 no-op。
 *
 * @param threadId — 要删除的线程 ID
 */
export async function deleteThread(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadDeleteArgs = { threadId }
    const result = await commands.threadDelete(args)
    if (result.status === 'error') {
      throw new Error(`thread/delete failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 归档/取消归档线程。
 *
 * 根据 archived 参数调用 `thread/archive` 或 `thread/unarchive` 命令。
 * 浏览器模式 no-op。
 *
 * @param threadId — 要操作的线程 ID
 * @param archived — true=归档，false=取消归档
 */
export async function archiveThread(
  threadId: ThreadId,
  archived: boolean
): Promise<void> {
  if (isTauri()) {
    const result = archived
      ? await commands.threadArchive({ threadId } satisfies ThreadArchiveArgs)
      : await commands.threadUnarchive({ threadId } satisfies ThreadUnarchiveArgs)
    if (result.status === 'error') {
      throw new Error(
        `thread/${archived ? 'archive' : 'unarchive'} failed: ${result.error.message}`
      )
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 重命名线程。
 *
 * 调用 `thread/set_name` 命令设置线程的新名称。
 * 浏览器模式 no-op。
 *
 * @param threadId — 要重命名的线程 ID
 * @param name — 新名称
 */
export async function renameThread(
  threadId: ThreadId,
  name: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadSetNameArgs = { threadId, name }
    const result = await commands.threadSetName(args)
    if (result.status === 'error') {
      throw new Error(`thread/set_name failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 设置线程置顶状态。
 *
 * 对齐原型 L12104-12107: 调用 `thread/metadata/update` 传入 `metadata: { pinned }`。
 *
 * Tauri 模式说明：
 *   当前 `ThreadMetadataUpdateArgs` DTO 仅暴露 `gitInfoJson` 字段，
 *   不支持 `pinned` 等通用 metadata 字段。
 *   后端协议层（app-server-protocol）的 `thread/metadata/update` 实际支持
 *   完整 metadata 更新，但 Tauri 桥接层 DTO 尚未扩展。
 *   待后端 DTO 扩展后，此处替换为 `commands.threadMetadataUpdate`。
 *   目前 Tauri 模式下为 no-op，仅靠 TanStack Query 乐观更新缓存反映变化。
 *
 * 浏览器 mock 模式：no-op（与 renameThread/archiveThread 一致），
 *   乐观更新由 useSetThreadPinned mutation 处理。
 *
 * @param threadId — 线程 ID
 * @param pinned — true=置顶，false=取消置顶
 */
export async function setThreadPinned(
  threadId: ThreadId,
  pinned: boolean
): Promise<void> {
  if (isTauri()) {
    // TODO: 待 ThreadMetadataUpdateArgs DTO 扩展支持 pinned 字段后启用
    // const args: ThreadMetadataUpdateArgs = {
    //   threadId,
    //   metadata: JSON.stringify({ pinned }),
    // }
    // const result = await commands.threadMetadataUpdate(args)
    // if (result.status === 'error') {
    //   throw new Error(`thread/metadata/update failed: ${result.error.message}`)
    // }

    // 后端 API 尚未实现 — 抛出明确错误而非静默 no-op，
    // 避免用户以为操作成功但数据实际未持久化（数据丢失风险）
    void threadId
    void pinned
    throw new Error('置顶功能尚未在后端实现（thread/metadata/update 待扩展 pinned 字段）')
  }
  // 浏览器开发模式 — no-op
}

/**
 * 按关键词搜索线程。
 *
 * 调用 `thread/search` 命令搜索匹配的线程。
 * 浏览器模式使用 mock 数据过滤。
 *
 * @param searchTerm — 搜索关键词
 * @returns 匹配的线程数组
 */
export async function searchThreads(searchTerm: string): Promise<Thread[]> {
  if (isTauri()) {
    const args: ThreadSearchArgs = { searchTerm, limit: 20 }
    const result = await commands.threadSearch(args)
    if (result.status === 'error') {
      throw new Error(`thread/search failed: ${result.error.message}`)
    }
    const parsed: ThreadListResponse = JSON.parse(result.data)
    return parsed.threads.map(adaptThread)
  }
  // 浏览器开发模式 — mock 过滤
  const q = searchTerm.toLowerCase()
  return getMockData().threads.filter(
    t =>
      t.title.toLowerCase().includes(q) ||
      (t.cwd !== null && t.cwd.toLowerCase().includes(q))
  )
}

/**
 * 分叉（复制）线程。
 *
 * 调用 `thread/fork` 命令创建线程的副本。
 * 浏览器模式使用 mock 复制。
 *
 * @param threadId — 要分叉的线程 ID
 * @returns 新线程，或 null（原线程不存在时）
 */
export async function forkThread(threadId: ThreadId): Promise<Thread | null> {
  if (isTauri()) {
    const args: ThreadForkArgs = { threadId }
    const result = await commands.threadFork(args)
    if (result.status === 'error') {
      if (result.error.kind === 'NotFound') {
        return null
      }
      throw new Error(`thread/fork failed: ${result.error.message}`)
    }
    const parsed: ThreadStartResponse = JSON.parse(result.data)
    return adaptThread(parsed.thread)
  }
  // 浏览器开发模式 — 使用集中式 mock 工厂函数分叉线程
  const original = getMockData().threads.find(t => t.id === threadId)
  if (!original) return null
  return forkMockThread(original)
}

// ============================================================================
// 生命周期扩展（resume / rollback）
// ============================================================================

/**
 * 恢复已存在的线程。
 *
 * 调用 `thread/resume` 命令加载历史线程并重新订阅事件流。
 * 与 `thread/start` 不同，resume 用于恢复已持久化的线程，
 * 可覆盖模型、工作目录等参数。
 *
 * @param threadId — 要恢复的线程 ID
 * @param options — 可选覆盖项（model/modelProvider/cwd/path/paramsJson）
 * @returns 恢复后的线程对象
 */
export async function resumeThread(
  threadId: ThreadId,
  options?: {
    model?: string | null
    modelProvider?: string | null
    cwd?: string | null
    path?: string | null
    paramsJson?: string | null
  }
): Promise<Thread> {
  if (isTauri()) {
    const args: ThreadResumeArgs = {
      threadId,
      // 条件展开避免 exactOptionalPropertyTypes 下显式赋 undefined
      ...(options?.model !== undefined ? { model: options.model } : {}),
      ...(options?.modelProvider !== undefined ? { modelProvider: options.modelProvider } : {}),
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.path !== undefined ? { path: options.path } : {}),
      ...(options?.paramsJson !== undefined ? { paramsJson: options.paramsJson } : {}),
    }
    const result = await commands.threadResume(args)
    if (result.status === 'error') {
      throw new Error(`thread/resume failed: ${result.error.message}`)
    }
    const parsed: ThreadStartResponse = JSON.parse(result.data)
    return adaptThread(parsed.thread)
  }
  // 浏览器开发模式 — 从 mock 查找，找不到时返回一个临时 mock 线程
  const found = getMockData().threads.find(t => t.id === threadId)
  if (found) return found
  return createMockThread(threadId, '已恢复的会话')
}

/**
 * 回滚线程指定数量的 turn。
 *
 * 调用 `thread/rollback` 命令（后端标记 DEPRECATED）。
 * 回滚后线程状态回到前 numTurns 个 turn 之前。
 *
 * @param threadId — 线程 ID
 * @param numTurns — 要回滚的 turn 数量
 */
export async function rollbackThread(
  threadId: ThreadId,
  numTurns: number
): Promise<void> {
  if (isTauri()) {
    const args: ThreadRollbackArgs = { threadId, numTurns }
    const result = await commands.threadRollback(args)
    if (result.status === 'error') {
      throw new Error(`thread/rollback failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

// ============================================================================
// 元数据 + Goal
// ============================================================================

/**
 * 更新线程元数据（目前仅支持 git_info 字段）。
 *
 * 调用 `thread/metadata/update` 命令，传入 Git 信息 JSON。
 * 协议层支持更多字段，DTO 用 gitInfoJson 承载。
 *
 * @param threadId — 线程 ID
 * @param gitInfoJson — Git 信息 JSON 字符串（sha/branch/originUrl，字段可为 null 清除）
 */
export async function updateThreadMetadata(
  threadId: ThreadId,
  gitInfoJson: string | null
): Promise<void> {
  if (isTauri()) {
    const args: ThreadMetadataUpdateArgs = {
      threadId,
      ...(gitInfoJson !== null ? { gitInfoJson } : {}),
    }
    const result = await commands.threadMetadataUpdate(args)
    if (result.status === 'error') {
      throw new Error(`thread/metadata/update failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/** thread/goal/get 响应的 JSON 结构 */
export interface ThreadGoalGetResponse {
  /** 目标描述文本（无目标时为 null） */
  objective: string | null
  /** 目标状态（active/paused/blocked/usageLimited/budgetLimited/complete） */
  status: string | null
  /** Token 预算（null 表示无限制） */
  tokenBudget: number | null
}

/**
 * 浏览器开发模式的运行时线程目标存储。
 *
 * 初始化时从 mock 数据加载（normalMockData.threadGoals），
 * 支持 getThreadGoal 读取和 clearThreadGoal 删除。
 * Tauri 生产模式不使用此 store（直接调用后端 API）。
 */
const mockGoalStore = {
  /** 内部 Map：threadId → ThreadGoalGetResponse */
  _goals: new Map<string, ThreadGoalGetResponse>(
    Object.entries(getMockData().threadGoals).map(([id, g]) => [
      id,
      { objective: g.objective, status: g.status, tokenBudget: g.tokenBudget },
    ])
  ),

  /** 获取线程目标，无目标时返回 null */
  getGoal(threadId: ThreadId): ThreadGoalGetResponse | null {
    return this._goals.get(threadId) ?? null
  },

  /** 清除线程目标 */
  clearGoal(threadId: ThreadId): void {
    this._goals.delete(threadId)
  },
}

/**
 * 设置线程目标。
 *
 * 调用 `thread/goal/set` 命令，为线程设置或更新目标。
 * 传入 null 表示清除对应字段。
 *
 * @param threadId — 线程 ID
 * @param objective — 目标描述（null 清除）
 * @param status — 目标状态（active/paused/blocked/...）
 * @param tokenBudget — Token 预算（null 清除）
 */
export async function setThreadGoal(
  threadId: ThreadId,
  options: {
    objective?: string | null
    status?: string | null
    tokenBudget?: number | null
  }
): Promise<void> {
  if (isTauri()) {
    const args: ThreadGoalSetArgs = {
      threadId,
      ...(options.objective !== undefined ? { objective: options.objective } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    }
    const result = await commands.threadGoalSet(args)
    if (result.status === 'error') {
      throw new Error(`thread/goal/set failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 获取线程当前目标。
 *
 * 调用 `thread/goal/get` 命令查询线程目标状态。
 *
 * @param threadId — 线程 ID
 * @returns 目标信息，或 null（无目标时）
 */
export async function getThreadGoal(
  threadId: ThreadId
): Promise<ThreadGoalGetResponse | null> {
  if (isTauri()) {
    const args: ThreadGoalGetArgs = { threadId }
    const result = await commands.threadGoalGet(args)
    if (result.status === 'error') {
      // NotFound 表示无目标，返回 null
      if (result.error.kind === 'NotFound') {
        return null
      }
      throw new Error(`thread/goal/get failed: ${result.error.message}`)
    }
    const parsed: ThreadGoalGetResponse = JSON.parse(result.data)
    return parsed
  }
  // 浏览器开发模式 — 从运行时 mock goal store 获取
  return mockGoalStore.getGoal(threadId)
}

/**
 * 清除线程目标。
 *
 * 调用 `thread/goal/clear` 命令移除线程的目标设定。
 *
 * @param threadId — 线程 ID
 */
export async function clearThreadGoal(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadGoalClearArgs = { threadId }
    const result = await commands.threadGoalClear(args)
    if (result.status === 'error') {
      throw new Error(`thread/goal/clear failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — 从运行时 mock goal store 删除
  mockGoalStore.clearGoal(threadId)
}

// ============================================================================
// 列表查询（loaded/list、turns/list、items/list、inject_items）
// ============================================================================

/** thread/loaded/list 响应的 JSON 结构 */
interface ThreadLoadedListResponse {
  /** 已加载的线程数组 */
  threads: RawThread[]
  /** 下一页游标（无更多数据时为 null） */
  nextCursor: string | null
}

/**
 * 列出当前会话已加载的线程。
 *
 * 调用 `thread/loaded/list` 命令，返回内存中活跃的线程列表
 * （与 thread/list 不同，list 返回磁盘持久化的全部线程）。
 *
 * @param cursor — 分页游标（首页为 null）
 * @param limit — 每页数量
 * @returns 线程数组与下一页游标
 */
export async function listLoadedThreads(
  cursor: string | null = null,
  limit: number | null = null
): Promise<{ threads: Thread[]; nextCursor: string | null }> {
  if (isTauri()) {
    const args: ThreadLoadedListArgs = {
      ...(cursor !== null ? { cursor } : {}),
      ...(limit !== null ? { limit } : {}),
    }
    const result = await commands.threadLoadedList(args)
    if (result.status === 'error') {
      throw new Error(`thread/loaded/list failed: ${result.error.message}`)
    }
    const parsed: ThreadLoadedListResponse = JSON.parse(result.data)
    return {
      threads: parsed.threads.map(adaptThread),
      nextCursor: parsed.nextCursor,
    }
  }
  // 浏览器开发模式 — mock
  return { threads: getMockData().threads, nextCursor: null }
}

/** thread/turns/list 响应的 JSON 结构（简化版） */
interface ThreadTurnsListResponse {
  /** turn 数组 */
  turns: RawTurn[]
  /** 下一页游标 */
  nextCursor: string | null
}

/**
 * 分页列出线程的 turn 历史。
 *
 * 调用 `thread/turns/list` 命令（experimental），
 * 支持按 cursor 分页、按 sortDirection 排序、按 itemsView 控制 item 详情级别。
 *
 * @param threadId — 线程 ID
 * @param options — 分页与排序选项
 * @returns turn 数组与下一页游标
 */
export async function listTurns(
  threadId: ThreadId,
  options?: {
    cursor?: string | null
    limit?: number | null
    sortDirection?: string | null
    itemsView?: string | null
  }
): Promise<{ turns: RawTurn[]; nextCursor: string | null }> {
  if (isTauri()) {
    const args: ThreadTurnsListArgs = {
      threadId,
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.sortDirection !== undefined ? { sortDirection: options.sortDirection } : {}),
      ...(options?.itemsView !== undefined ? { itemsView: options.itemsView } : {}),
    }
    const result = await commands.threadTurnsList(args)
    if (result.status === 'error') {
      throw new Error(`thread/turns/list failed: ${result.error.message}`)
    }
    const parsed: ThreadTurnsListResponse = JSON.parse(result.data)
    return { turns: parsed.turns, nextCursor: parsed.nextCursor }
  }
  // 浏览器开发模式 — mock
  return { turns: [], nextCursor: null }
}

/** thread/items/list 响应的 JSON 结构 */
interface ThreadItemsListResponse {
  /** ThreadItem 原始数组 */
  items: RawThreadItem[]
  /** 下一页游标 */
  nextCursor: string | null
}

/**
 * 分页列出线程的消息项。
 *
 * 调用 `thread/items/list` 命令（experimental，核心命令），
 * 直接拉取 ThreadItem 数组（不通过 turn 包装），
 * 用于消息列表分页加载、增量刷新等场景。
 *
 * 返回值已通过 `threadItemsToMessages` 适配为前端 Message 类型。
 *
 * @param threadId — 线程 ID
 * @param options — 过滤与分页选项
 * @returns 消息数组与下一页游标
 */
export async function listThreadItems(
  threadId: ThreadId,
  options?: {
    turnId?: string | null
    cursor?: string | null
    limit?: number | null
    sortDirection?: string | null
  }
): Promise<{ messages: Message[]; nextCursor: string | null }> {
  if (isTauri()) {
    const args: ThreadItemsListArgs = {
      threadId,
      ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.sortDirection !== undefined ? { sortDirection: options.sortDirection } : {}),
    }
    const result = await commands.threadItemsList(args)
    if (result.status === 'error') {
      throw new Error(`thread/items/list failed: ${result.error.message}`)
    }
    const parsed: ThreadItemsListResponse = JSON.parse(result.data)
    // 复用 thread-items 适配层，将 18 种 ThreadItem 变体转为前端 Message
    return {
      messages: threadItemsToMessages(parsed.items),
      nextCursor: parsed.nextCursor,
    }
  }
  // 浏览器开发模式 — mock
  return { messages: [], nextCursor: null }
}

/**
 * 向线程注入原始 Responses API items。
 *
 * 调用 `thread/inject_items` 命令，绕过 turn 机制直接向线程追加
 * 原始 item 对象（如系统消息、上下文补全等）。
 *
 * @param threadId — 线程 ID
 * @param itemsJson — items 的 JSON 数组字符串（每个元素是 Responses API item 对象）
 */
export async function injectThreadItems(
  threadId: ThreadId,
  itemsJson: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadInjectItemsArgs = { threadId, itemsJson }
    const result = await commands.threadInjectItems(args)
    if (result.status === 'error') {
      throw new Error(`thread/inject_items failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

// ============================================================================
// 操作（compact/start、shellCommand、approveGuardianDeniedAction）
// ============================================================================

/**
 * 启动线程压缩。
 *
 * 调用 `thread/compact/start` 命令，触发线程历史压缩，
 * 将早期 turn 摘要化以释放上下文窗口。
 *
 * @param threadId — 线程 ID
 */
export async function compactThread(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadCompactStartArgs = { threadId }
    const result = await commands.threadCompactStart(args)
    if (result.status === 'error') {
      throw new Error(`thread/compact/start failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 在线程上下文中执行 shell 命令。
 *
 * 调用 `thread/shellCommand` 命令，执行用户输入的 shell 命令。
 * 与 turn/start 不同，shellCommand 不触发 LLM 推理，
 * 仅执行命令并将结果写入线程历史。
 *
 * @param threadId — 线程 ID
 * @param command — 要执行的 shell 命令
 */
export async function executeShellCommand(
  threadId: ThreadId,
  command: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadShellCommandArgs = { threadId, command }
    const result = await commands.threadShellCommand(args)
    if (result.status === 'error') {
      throw new Error(`thread/shellCommand failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 批准 Guardian 拒绝的操作。
 *
 * 调用 `thread/approveGuardianDeniedAction` 命令，
 * 用户手动批准 Guardian 安全机制拒绝的操作（覆盖 Guardian 决策）。
 *
 * @param threadId — 线程 ID
 * @param eventJson — GuardianAssessmentEvent 的 JSON 字符串
 */
export async function approveGuardianDeniedAction(
  threadId: ThreadId,
  eventJson: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadApproveGuardianDeniedActionArgs = { threadId, eventJson }
    const result = await commands.threadApproveGuardianDeniedAction(args)
    if (result.status === 'error') {
      throw new Error(`thread/approveGuardianDeniedAction failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

// ============================================================================
// 实验性功能（elicitation / settings / memoryMode）
// ============================================================================

/**
 * 增加线程的 elicitation 计数（experimental）。
 *
 * 调用 `thread/increment_elicitation` 命令，
 * 用于追踪用户主动引导（elicitation）的次数。
 *
 * @param threadId — 线程 ID
 */
export async function incrementElicitation(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadIncrementElicitationArgs = { threadId }
    const result = await commands.threadIncrementElicitation(args)
    if (result.status === 'error') {
      throw new Error(`thread/increment_elicitation failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 减少线程的 elicitation 计数（experimental）。
 *
 * 调用 `thread/decrement_elicitation` 命令。
 *
 * @param threadId — 线程 ID
 */
export async function decrementElicitation(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadDecrementElicitationArgs = { threadId }
    const result = await commands.threadDecrementElicitation(args)
    if (result.status === 'error') {
      throw new Error(`thread/decrement_elicitation failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 更新线程设置（experimental）。
 *
 * 调用 `thread/settings/update` 命令，传入完整协议参数 JSON。
 * 支持字段：cwd/approvalPolicy/sandboxPolicy/model/serviceTier/effort/
 * summary/collaborationMode/personality 等。
 *
 * @param threadId — 线程 ID
 * @param paramsJson — 完整协议参数 JSON 字符串
 */
export async function updateThreadSettings(
  threadId: ThreadId,
  paramsJson: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadSettingsUpdateArgs = { threadId, paramsJson }
    const result = await commands.threadSettingsUpdate(args)
    if (result.status === 'error') {
      throw new Error(`thread/settings/update failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 设置线程的记忆模式（experimental）。
 *
 * 调用 `thread/memoryMode/set` 命令，开启或关闭线程的长期记忆。
 *
 * @param threadId — 线程 ID
 * @param mode — 记忆模式（enabled/disabled）
 */
export async function setMemoryMode(
  threadId: ThreadId,
  mode: 'enabled' | 'disabled'
): Promise<void> {
  if (isTauri()) {
    const args: ThreadMemoryModeSetArgs = { threadId, mode }
    const result = await commands.threadMemoryModeSet(args)
    if (result.status === 'error') {
      throw new Error(`thread/memoryMode/set failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

// ============================================================================
// 后台终端管理（Background Terminals）
// ============================================================================

/**
 * 清理线程的后台终端（experimental）。
 *
 * 调用 `thread/backgroundTerminals/clean` 命令，
 * 终止该线程关联的所有后台终端进程。
 *
 * @param threadId — 线程 ID
 */
export async function cleanBackgroundTerminals(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadBackgroundTerminalsCleanArgs = { threadId }
    const result = await commands.threadBackgroundTerminalsClean(args)
    if (result.status === 'error') {
      throw new Error(`thread/backgroundTerminals/clean failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/** thread/backgroundTerminals/list 响应的 JSON 结构 */
interface BackgroundTerminalsListResponse {
  /** 后台终端数组（每个元素为一个终端进程信息） */
  terminals: unknown[]
  /** 下一页游标 */
  nextCursor: string | null
}

/**
 * 列出线程的后台终端（experimental）。
 *
 * 调用 `thread/backgroundTerminals/list` 命令，
 * 分页查询该线程关联的后台终端进程列表。
 *
 * 返回值为原始 JSON（结构复杂且 experimental，未定义完整类型），
 * 调用方按需 cast。
 *
 * @param threadId — 线程 ID
 * @param cursor — 分页游标
 * @param limit — 每页数量
 * @returns 终端数组与下一页游标
 */
export async function listBackgroundTerminals(
  threadId: ThreadId,
  cursor: string | null = null,
  limit: number | null = null
): Promise<{ terminals: unknown[]; nextCursor: string | null }> {
  if (isTauri()) {
    const args: ThreadBackgroundTerminalsListArgs = {
      threadId,
      ...(cursor !== null ? { cursor } : {}),
      ...(limit !== null ? { limit } : {}),
    }
    const result = await commands.threadBackgroundTerminalsList(args)
    if (result.status === 'error') {
      throw new Error(`thread/backgroundTerminals/list failed: ${result.error.message}`)
    }
    const parsed: BackgroundTerminalsListResponse = JSON.parse(result.data)
    return { terminals: parsed.terminals, nextCursor: parsed.nextCursor }
  }
  // 浏览器开发模式 — mock
  return { terminals: [], nextCursor: null }
}

/**
 * 终止指定后台终端（experimental）。
 *
 * 调用 `thread/backgroundTerminals/terminate` 命令，
 * 终止线程内指定的后台终端进程。
 *
 * @param threadId — 线程 ID
 * @param processId — 要终止的进程 ID
 */
export async function terminateBackgroundTerminal(
  threadId: ThreadId,
  processId: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadBackgroundTerminalsTerminateArgs = { threadId, processId }
    const result = await commands.threadBackgroundTerminalsTerminate(args)
    if (result.status === 'error') {
      throw new Error(`thread/backgroundTerminals/terminate failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

// ============================================================================
// 实时语音/文本对话（Realtime，experimental）
// ============================================================================

/**
 * 启动线程的实时会话（experimental）。
 *
 * 调用 `thread/realtime/start` 命令，开启 Realtime API 会话。
 * 协议层 ThreadRealtimeStartParams 有 13 个字段（含 outputModality 等），
 * 通过 paramsJson 透传完整参数。
 *
 * @param threadId — 线程 ID
 * @param paramsJson — 完整协议参数 JSON（必填 outputModality: text/audio）
 */
export async function startRealtime(
  threadId: ThreadId,
  paramsJson: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadRealtimeStartArgs = { threadId, paramsJson }
    const result = await commands.threadRealtimeStart(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/start failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 向实时会话追加音频块（experimental）。
 *
 * 调用 `thread/realtime/appendAudio` 命令，
 * 传入 base64 编码的音频块（对应 ThreadRealtimeAudioChunk）。
 *
 * @param threadId — 线程 ID
 * @param audioJson — 音频块 JSON 字符串（{ data, sampleRate, numChannels, ... }）
 */
export async function appendRealtimeAudio(
  threadId: ThreadId,
  audioJson: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadRealtimeAppendAudioArgs = { threadId, audioJson }
    const result = await commands.threadRealtimeAppendAudio(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/appendAudio failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 向实时会话追加文本（experimental）。
 *
 * 调用 `thread/realtime/appendText` 命令，
 * 向 Realtime 会话注入文本输入（user/developer/assistant 角色）。
 *
 * @param threadId — 线程 ID
 * @param text — 要追加的文本
 * @param role — 角色（user/developer/assistant，默认 user）
 */
export async function appendRealtimeText(
  threadId: ThreadId,
  text: string,
  role: string | null = null
): Promise<void> {
  if (isTauri()) {
    const args: ThreadRealtimeAppendTextArgs = {
      threadId,
      text,
      ...(role !== null ? { role } : {}),
    }
    const result = await commands.threadRealtimeAppendText(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/appendText failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 向实时会话追加语音合成文本（experimental）。
 *
 * 调用 `thread/realtime/appendSpeech` 命令，
 * 将文本合成为语音输出到 Realtime 会话。
 *
 * @param threadId — 线程 ID
 * @param text — 要合成的文本
 */
export async function appendRealtimeSpeech(
  threadId: ThreadId,
  text: string
): Promise<void> {
  if (isTauri()) {
    const args: ThreadRealtimeAppendSpeechArgs = { threadId, text }
    const result = await commands.threadRealtimeAppendSpeech(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/appendSpeech failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/**
 * 停止线程的实时会话（experimental）。
 *
 * 调用 `thread/realtime/stop` 命令，关闭 Realtime API 会话。
 *
 * @param threadId — 线程 ID
 */
export async function stopRealtime(threadId: ThreadId): Promise<void> {
  if (isTauri()) {
    const args: ThreadRealtimeStopArgs = { threadId }
    const result = await commands.threadRealtimeStop(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/stop failed: ${result.error.message}`)
    }
    return
  }
  // 浏览器开发模式 — no-op
}

/** thread/realtime/listVoices 响应的 JSON 结构 */
interface RealtimeListVoicesResponse {
  /** 可用语音列表（每个元素为语音 ID 字符串） */
  voices: string[]
}

/**
 * 列出 Realtime API 可用的语音（experimental）。
 *
 * 调用 `thread/realtime/listVoices` 命令，
 * 返回 Realtime 会话支持的语音 ID 列表。
 *
 * @returns 语音 ID 数组
 */
export async function listRealtimeVoices(): Promise<string[]> {
  if (isTauri()) {
    // 协议层为空结构体，DTO 也为空（specta 要求至少有占位）
    const args: ThreadRealtimeListVoicesArgs = {}
    const result = await commands.threadRealtimeListVoices(args)
    if (result.status === 'error') {
      throw new Error(`thread/realtime/listVoices failed: ${result.error.message}`)
    }
    const parsed: RealtimeListVoicesResponse = JSON.parse(result.data)
    return parsed.voices
  }
  // 浏览器开发模式 — mock
  return getMockData().realtimeVoices
}
