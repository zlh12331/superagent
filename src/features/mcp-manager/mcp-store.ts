/**
 * MCP Store — MCP 服务器状态管理（Task 20）
 *
 * 维护 MCP 服务器列表（servers）、加载状态（loading）、错误信息（error）。
 * 该 store 不持久化：服务器配置由后端 codex-rs 管理，
 * 这里仅缓存 UI 展示所需的内存状态。
 *
 * 数据流:
 *   useMcpServers 加载/监听 → 更新 store → UI 响应渲染
 *
 * @see src/features/mcp-manager/useMcpServers.ts — 加载 hook
 * @see src/lib/codex/mcp.ts — listMcpServers / onMcpServerStatusUpdated
 */

import { create, type StateCreator } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { McpServer } from '@/lib/codex/types'

export interface McpState {
  /** MCP 服务器列表 */
  servers: McpServer[]
  /** 是否正在加载 */
  loading: boolean
  /** 错误信息（加载失败时） */
  error: string | null
  /** 设置服务器列表 */
  setServers: (servers: McpServer[]) => void
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置错误信息 */
  setError: (error: string | null) => void
  /** 添加或更新服务器（按 id 匹配） */
  upsertServer: (server: McpServer) => void
  /** 移除服务器 */
  removeServer: (id: string) => void
}

/**
 * MCP 状态切片 creator。
 *
 * 使用 Zustand 的 StateCreator 模式定义状态切片，便于：
 *  - 在测试中通过 `create()(mcpStoreCreator)` 创建隔离实例，避免全局单例污染
 *  - 与 devtools middleware 组合时保持类型推导
 *
 * 实现要点：
 *  - 所有写操作通过 `set()` 显式标注 action 名（如 'setServers'），
 *    便于 Redux DevTools 中区分变更来源
 *  - `upsertServer` 采用不可变更新（拷贝数组后替换），避免直接修改 state
 *
 * @param set — Zustand 内部注入的 set 函数
 * @returns 完整的 McpState 状态切片
 *
 * @example
 * // 直接使用单例
 * const servers = useMcpStore(s => s.servers)
 * // 测试中创建隔离实例
 * const testStore = create<McpState>()(devtools(mcpStoreCreator))
 */
const mcpStoreCreator: StateCreator<
  McpState,
  [['zustand/devtools', never]]
> = set => ({
  servers: [],
  loading: false,
  error: null,

  setServers: servers => set({ servers }, undefined, 'setServers'),

  setLoading: loading => set({ loading }, undefined, 'setLoading'),

  setError: error => set({ error }, undefined, 'setError'),

  upsertServer: server =>
    set(
      state => {
        // 按 id 查找已有服务器，存在则替换，不存在则追加
        const idx = state.servers.findIndex(s => s.id === server.id)
        if (idx === -1) {
          return { servers: [...state.servers, server] }
        }
        const next = [...state.servers]
        next[idx] = server
        return { servers: next }
      },
      undefined,
      'upsertServer'
    ),

  removeServer: id =>
    set(
      state => ({
        servers: state.servers.filter(s => s.id !== id),
      }),
      undefined,
      'removeServer'
    ),
})

/**
 * useMcpStore — MCP 服务器状态单例 hook。
 *
 * 由 `create()` 包装 `mcpStoreCreator` 并应用 devtools middleware，
 * 在 Redux DevTools 中以 `mcp-store` 名字展示。
 *
 * 使用方式：
 *  - 读取状态：`const servers = useMcpStore(s => s.servers)`
 *  - 写入状态：`const setServers = useMcpStore(s => s.setServers)`
 *
 * @example
 * function MyComponent() {
 *   const servers = useMcpStore(s => s.servers)
 *   const upsertServer = useMcpStore(s => s.upsertServer)
 *   // ...
 * }
 */
export const useMcpStore = create<McpState>()(
  devtools(mcpStoreCreator, { name: 'mcp-store' })
)
