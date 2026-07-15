/**
 * Codex API — Plugin 域
 *
 * 插件管理：列出、安装、卸载、读取详情。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * 后端命令已实现（4 个 Tauri command）：
 * - plugin_list — 列出可用插件（可按工作目录和市场类型过滤）
 * - plugin_install — 从指定市场安装插件
 * - plugin_uninstall — 卸载指定插件
 * - plugin_read — 读取指定插件的详细信息
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — PluginInfo 类型
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  PluginListArgs,
  PluginInstallArgs,
  PluginUninstallArgs,
  PluginReadArgs,
} from '@/lib/bindings'
import type { PluginInfo } from './types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的插件数据源
import { getMockData } from './mock'

// ---------------------------------------------------------------------------
// Tauri 响应类型（简化版，与后端 codex-rs 协议对齐）
// ---------------------------------------------------------------------------

/** plugin/list 响应的 JSON 结构（简化版） */
interface PluginListResponse {
  plugins?: PluginInfo[]
}

/** plugin/read 响应的 JSON 结构（简化版） */
interface PluginReadResponse {
  plugin?: PluginInfo
}

// ---------------------------------------------------------------------------
// API 函数
// ---------------------------------------------------------------------------

/**
 * 列出可用插件。
 *
 * Tauri 模式调用 `plugin/list` 命令（可通过工作目录和市场类型过滤），
 * 浏览器模式返回 mock 数据。
 *
 * @param cwds — 工作目录列表，用于发现仓库级市场（可选）
 * @param marketplaceKinds — 市场类型过滤（如 `['local', 'remote']`，可选）
 * @returns 插件列表
 */
export async function listPlugins(
  cwds?: string[] | null,
  marketplaceKinds?: string[] | null
): Promise<PluginInfo[]> {
  if (isTauri()) {
    const args: PluginListArgs = {
      cwds: cwds ?? null,
      marketplaceKinds: marketplaceKinds ?? null,
    }
    const result = await commands.pluginList(args)
    if (result.status === 'error') {
      throw new Error(`plugin/list failed: ${result.error.message}`)
    }
    const parsed: PluginListResponse = JSON.parse(result.data)
    return parsed.plugins ?? []
  }

  // 浏览器开发模式 — 返回 mock 数据
  return getMockData().plugins
}

/**
 * 安装插件。
 *
 * Tauri 模式调用 `plugin/install` 命令（从指定市场安装），
 * 浏览器模式为 no-op。
 *
 * `marketplacePath` 和 `remoteMarketplaceName` 二选一，都为空时使用默认市场。
 *
 * @param pluginName — 要安装的插件名称（必填）
 * @param marketplacePath — 本地市场路径（可选，与 remoteMarketplaceName 互斥）
 * @param remoteMarketplaceName — 远程市场名称（可选，与 marketplacePath 互斥）
 */
export async function installPlugin(
  pluginName: string,
  marketplacePath?: string | null,
  remoteMarketplaceName?: string | null
): Promise<void> {
  if (isTauri()) {
    const args: PluginInstallArgs = {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    }
    const result = await commands.pluginInstall(args)
    if (result.status === 'error') {
      throw new Error(`plugin/install failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 卸载插件。
 *
 * Tauri 模式调用 `plugin/uninstall` 命令，
 * 浏览器模式为 no-op。
 *
 * @param pluginId — 要卸载的插件 ID（必填）
 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  if (isTauri()) {
    const args: PluginUninstallArgs = { pluginId }
    const result = await commands.pluginUninstall(args)
    if (result.status === 'error') {
      throw new Error(`plugin/uninstall failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 读取插件详情。
 *
 * Tauri 模式调用 `plugin/read` 命令，
 * 浏览器模式从 mock 查找。
 *
 * @param pluginName — 要读取的插件名称（必填）
 * @param marketplacePath — 本地市场路径（可选，与 remoteMarketplaceName 互斥）
 * @param remoteMarketplaceName — 远程市场名称（可选，与 marketplacePath 互斥）
 * @returns 插件信息，或 null（不存在时）
 */
export async function readPlugin(
  pluginName: string,
  marketplacePath?: string | null,
  remoteMarketplaceName?: string | null
): Promise<PluginInfo | null> {
  if (isTauri()) {
    const args: PluginReadArgs = {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    }
    const result = await commands.pluginRead(args)
    if (result.status === 'error') {
      // NotFound 表示插件不存在，返回 null 而非抛错
      if (result.error.kind === 'NotFound') {
        return null
      }
      throw new Error(`plugin/read failed: ${result.error.message}`)
    }
    const parsed: PluginReadResponse = JSON.parse(result.data)
    return parsed.plugin ?? null
  }

  // 浏览器开发模式 — 从 mock 查找
  return getMockData().plugins.find(p => p.name === pluginName) ?? null
}
