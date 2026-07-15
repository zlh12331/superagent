/**
 * @file Remote Control Store — 远程控制状态管理（Zustand）
 *
 * 对齐 prototype.html §2.17 Remote 视图与 §C Remote Control 接口。
 *
 * 后端协议（7 个 API，目前为实验性，后端 Tauri 命令尚未实现）：
 *  - remoteControl/enable        — 启用远程控制
 *  - remoteControl/disable       — 禁用远程控制
 *  - remoteControl/status/read   — 读取连接状态
 *  - remoteControl/pairing/start — 启动配对流程，获取配对码
 *  - remoteControl/pairing/status— 查询配对是否已被认领
 *  - remoteControl/client/list   — 列出已配对客户端
 *  - remoteControl/client/revoke — 撤销客户端访问权限
 *
 * 当前实现：浏览器 mock 模式（与原型一致），数据保存在内存。
 * 后端就绪后：将 mock 方法替换为 Tauri 命令调用。
 *
 * 状态管理决策树位置：Zustand（跨组件共享的异步状态 + 操作）
 *
 * @see prototype.html L7668-7717 — mock 后端 remoteControl 接口
 * @see prototype.html L14562-14644 — renderRemote 视图渲染
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import { logger } from '@/lib/logger'

// ===== 类型定义 =====

/**
 * 远程控制连接状态
 *
 * 对齐后端 RemoteControlConnectionStatus 枚举：
 *  - connected: 已连接（远程控制已启用）
 *  - disabled:  已禁用
 *  - connecting: 连接中（过渡态，前端扩展）
 */
export type RemoteControlStatus = 'connected' | 'disabled' | 'connecting'

/**
 * 已配对客户端信息
 *
 * 对齐后端 RemoteControlClient 结构（prototype.html L14603 渲染字段）。
 */
export interface RemoteControlClient {
  /** 客户端唯一 ID */
  clientId: string
  /** 客户端显示名称 */
  name: string
  /** 客户端操作系统（如 "macOS 14.5"） */
  os: string
  /** 客户端 IP 地址 */
  ip: string
  /** 最后活跃时间（相对描述，如 "2分钟前"） */
  last: string
  /** 在线状态 */
  status: 'online' | 'offline'
}

/**
 * 远程控制状态响应（remoteControl/status/read 返回）
 *
 * 对齐后端 RemoteControlStatusReadResponse。
 */
export interface RemoteControlStatusResponse {
  status: RemoteControlStatus
  serverName: string
  installationId: string
  environmentId: string | null
}

/**
 * 配对启动响应（remoteControl/pairing/start 返回）
 *
 * 对齐后端 RemoteControlPairingStartResponse。
 */
export interface PairingStartResponse {
  /** 6 位配对码（如 "A3K9X2"） */
  pairingCode: string
  /** 手动配对码（可选，当请求 manualCode=true 时返回） */
  manualPairingCode: string | null
  /** 环境 ID */
  environmentId: string
  /** 过期时间（Unix 时间戳，秒） */
  expiresAt: number
}

/**
 * 配对状态响应（remoteControl/pairing/status 返回）
 *
 * 对齐后端 RemoteControlPairingStatusResponse。
 * 用于初始化时查询当前配对码是否已被客户端认领：
 *  - claimed: false → 配对码已失效或未被认领，需清空本地缓存的 pairingCode
 *  - claimed: true  → 配对码有效，已有客户端通过此码完成配对
 */
export interface PairingStatusResponse {
  /** 配对是否已被客户端认领 */
  claimed: boolean
}

// ===== Store 状态接口 =====

/**
 * Remote Control store 状态接口。
 *
 * 字段分组：
 *  - 连接状态：status / serverName / installationId
 *  - 配对信息：pairingCode / pairingExpiresAt
 *  - 客户端列表：clients
 *  - 操作加载态：loading（用于禁用按钮防止重复点击）
 */
export interface RemoteStoreState {
  /** 当前连接状态 */
  status: RemoteControlStatus
  /** 服务器名称（从 status/read 获取） */
  serverName: string
  /** 安装 ID */
  installationId: string
  /** 配对码（未配对时为 null） */
  pairingCode: string | null
  /** 配对码过期时间（Unix 时间戳，毫秒） */
  pairingExpiresAt: number | null
  /** 已配对客户端列表 */
  clients: RemoteControlClient[]
  /** 操作进行中标志（启用/禁用/撤销时为 true） */
  loading: boolean

  // ===== 操作方法 =====

  /**
   * 初始化：读取状态 + 客户端列表。
   * 视图首次渲染时调用（对齐原型 initRemote → renderRemote）。
   */
  initialize: () => Promise<void>
  /**
   * 启用远程控制并启动配对流程。
   * 对齐原型：remoteControl/enable + remoteControl/pairing/start
   */
  enable: () => Promise<void>
  /**
   * 禁用远程控制，清空配对码和客户端列表。
   * 对齐原型：remoteControl/disable
   */
  disable: () => Promise<void>
  /**
   * 撤销指定客户端的访问权限。
   * 对齐原型：remoteControl/client/revoke
   */
  revokeClient: (clientId: string) => Promise<void>
  /**
   * 刷新客户端列表（对齐原型 remoteControl/client/list）。
   * @returns 更新后的客户端列表（同时写入 store）
   */
  refreshClients: () => Promise<RemoteControlClient[]>
}

// ===== Mock 数据 =====

/**
 * Mock 已配对客户端列表。
 *
 * 对齐原型 store.remoteControl.clients 初始为空数组，
 * 这里提供 2 个示例客户端用于演示 UI 布局。
 */
const MOCK_CLIENTS: RemoteControlClient[] = [
  {
    clientId: 'client-001',
    name: 'MacBook Pro',
    os: 'macOS 14.5',
    ip: '192.168.1.42',
    last: '2分钟前',
    status: 'online',
  },
  {
    clientId: 'client-002',
    name: 'Windows Desktop',
    os: 'Windows 11',
    ip: '192.168.1.88',
    last: '1小时前',
    status: 'offline',
  },
]

/**
 * 生成 6 位随机配对码（大写字母+数字）。
 * 对齐原型 L7693: Math.random().toString(36).substring(2, 8).toUpperCase()
 */
function generatePairingCode(): string {
  return Math.random()
    .toString(36)
    .substring(2, 8)
    .toUpperCase()
}

// ===== Store 实现 =====

/**
 * Remote Control store 实现。
 *
 * 所有 API 调用当前为 mock 实现（内存操作 + 模拟延迟），
 * 后端 Tauri 命令就绪后替换为真实调用。
 *
 * 状态更新策略：
 *  - 操作前设置 loading=true，操作后设置 loading=false
 *  - 启用时立即获取配对码（两步合并为一个用户操作）
 *  - 禁用时清空所有配对状态和客户端列表
 */
const remoteStoreCreator: StateCreator<
  RemoteStoreState,
  [['zustand/devtools', never]]
> = (set, get) => ({
  // ---- 初始状态 ----
  status: 'disabled',
  serverName: '',
  installationId: '',
  pairingCode: null,
  pairingExpiresAt: null,
  clients: [],
  loading: false,

  // ===== 初始化 =====

  initialize: async () => {
    logger.debug('Remote control store initializing')
    // 步骤1：读取当前状态（mock：默认 disabled）
    // 对齐原型 L14573: remoteControl/status/read
    const statusResponse: RemoteControlStatusResponse = {
      status: 'disabled',
      serverName: 'codex-mock-server',
      installationId: 'mock-install-001',
      environmentId: null,
    }

    // 步骤2：读取已配对客户端列表
    // 对齐原型 L14591: remoteControl/client/list
    const clients = await get().refreshClients()

    // 步骤3：查询配对状态（对齐原型 L14581: remoteControl/pairing/status）
    // 若 claimed: false 则清空本地 pairingCode（避免展示已失效的配对码）
    // mock 模式下返回 { claimed: false }，与原型一致
    const pairingStatus: PairingStatusResponse = { claimed: false }

    set(
      {
        status: statusResponse.status,
        serverName: statusResponse.serverName,
        installationId: statusResponse.installationId,
        clients,
        // 配对未被认领时清空 pairingCode（对齐原型 L14583-14585）
        pairingCode: pairingStatus.claimed ? get().pairingCode : null,
        pairingExpiresAt: pairingStatus.claimed
          ? get().pairingExpiresAt
          : null,
      },
      undefined,
      'initialize'
    )
  },

  // ===== 启用远程控制 =====

  enable: async () => {
    set({ loading: true }, undefined, 'enable/start')

    try {
      // 模拟网络延迟
      await new Promise<void>(resolve => setTimeout(resolve, 300))

      // 步骤1：启用远程控制（mock：直接设置状态）
      set(
        {
          status: 'connected',
          serverName: 'codex-mock-server',
          installationId: 'mock-install-001',
        },
        undefined,
        'enable/status'
      )

      // 步骤2：启动配对流程，获取配对码
      const code = generatePairingCode()
      const expiresAt = Date.now() + 5 * 60 * 1000 // 5 分钟后过期

      set(
        {
          pairingCode: code,
          pairingExpiresAt: expiresAt,
        },
        undefined,
        'enable/pairing'
      )

      logger.info('Remote control enabled', { pairingCode: code })
    } finally {
      set({ loading: false }, undefined, 'enable/end')
    }
  },

  // ===== 禁用远程控制 =====

  disable: async () => {
    set({ loading: true }, undefined, 'disable/start')

    try {
      // 模拟网络延迟
      await new Promise<void>(resolve => setTimeout(resolve, 300))

      // 禁用远程控制：清空所有状态
      set(
        {
          status: 'disabled',
          pairingCode: null,
          pairingExpiresAt: null,
          clients: [],
        },
        undefined,
        'disable/done'
      )

      logger.info('Remote control disabled')
    } finally {
      set({ loading: false }, undefined, 'disable/end')
    }
  },

  // ===== 撤销客户端 =====

  revokeClient: async (clientId: string) => {
    set({ loading: true }, undefined, 'revoke/start')

    try {
      // 模拟网络延迟
      await new Promise<void>(resolve => setTimeout(resolve, 200))

      // 从列表中移除指定客户端
      set(
        state => ({
          clients: state.clients.filter(c => c.clientId !== clientId),
        }),
        undefined,
        'revoke/done'
      )

      logger.info('Client revoked', { clientId })
    } finally {
      set({ loading: false }, undefined, 'revoke/end')
    }
  },

  // ===== 刷新客户端列表 =====

  refreshClients: async () => {
    // 模拟网络延迟
    await new Promise<void>(resolve => setTimeout(resolve, 200))

    // 仅在已启用时返回 mock 客户端（对齐原型：禁用时 clients=[]）
    const isEnabled = get().status === 'connected'
    const clients = isEnabled ? MOCK_CLIENTS : []

    set({ clients }, undefined, 'refreshClients')
    return clients
  },
})

/**
 * Remote Control store 单例。
 *
 * 使用方式：
 *  - React 组件：`const status = useRemoteStore(s => s.status)`
 *  - 非 React 模块：`useRemoteStore.getState().enable()`
 */
export const useRemoteStore = create<RemoteStoreState>()(
  devtools(remoteStoreCreator, {
    name: 'remote-store',
  })
)
