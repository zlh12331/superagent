/**
 * Boundary 场景 mock 数据
 *
 * 所有列表为空、account 为 null，用于调试空状态 UI。
 * 例如：无线程时的欢迎屏、无消息时的占位符、未登录时的登录引导等。
 *
 * @see src/lib/codex/mock/types.ts — MockData 接口定义
 */

import type { MockData } from '../types'

/**
 * Boundary 场景的完整 mock 数据
 *
 * 所有数组字段为空，account 为 null。
 * fileTree 提供一个空的根节点（类型不允许 null）。
 * turn/config/commandResult 保留默认值（这些字段在空状态下不会被访问）。
 */
export const boundaryMockData: MockData = {
  threads: [],
  messages: [],
  turn: {
    id: 'turn-empty',
    threadId: 'thread-empty',
    status: 'completed',
    startedAt: 0,
    completedAt: 0,
  },
  // 空状态：无线程目标
  threadGoals: {},
  account: null,
  config: {
    model: '',
    temperature: 0,
    maxTokens: 0,
    approvalMode: 'manual',
    sandbox: false,
  },
  fileEntries: [],
  fileTree: {
    name: 'empty',
    path: '/',
    type: 'folder',
    children: [],
  },
  allFiles: [],
  mcpServers: [],
  mcpTools: [],
  mcpResources: [],
  plugins: [],
  processes: [],
  commandResult: {
    commandId: 'cmd-empty',
    exitCode: 0,
    stdout: '',
    stderr: '',
    duration: 0,
  },
  realtimeVoices: [],
  // UI 层后端数据 — 空状态
  usageStats: [],
  chatStats: {
    tokenRate: '0 tok/s',
    rateLimit: '—',
    safetyBufferPercent: 0,
    modelReroute: '',
  },
}
