/**
 * Mock 层统一入口
 *
 * 汇总所有 mock 模块的导出，为各 API 文件提供单一 import 来源。
 *
 * ## 核心导出
 *
 * - getMockData(): 根据当前场景返回 MockData
 * - shouldFail(apiName): error 场景下检查 API 是否应抛错
 * - getMockError(apiName): error 场景下生成 Error 实例
 * - mockScenario: 当前场景（normal/boundary/error）
 *
 * ## 场景切换
 *
 * 通过 VITE_MOCK_SCENARIO 环境变量在编译时注入：
 * - 未设置或 'normal': 正常数据
 * - 'boundary': 空状态数据
 * - 'error': 正常数据 + 部分 API 抛错
 *
 * 运行时不可切换（避免状态不一致）。
 *
 * @see src/lib/codex/mock/types.ts — 类型定义
 * @see src/lib/codex/mock/scenarios/normal.ts — normal 场景数据
 * @see src/lib/codex/mock/scenarios/boundary.ts — boundary 场景数据
 * @see src/lib/codex/mock/scenarios/error.ts — error 场景配置
 */

import type { MockScenario, MockData } from './types'
import { normalMockData } from './scenarios/normal'
import { boundaryMockData } from './scenarios/boundary'
import { errorScenarioConfig } from './scenarios/error'

// 重新导出子模块（供 API 文件直接 import）
export { mockEventBus } from './event-bus'
export { universalListen } from './listen'
export { simulateTurn } from './event-emitter'
export { createMockThread, createMockTurn, forkMockThread } from './scenarios/normal'
export type { MockScenario, MockData, ErrorScenarioConfig } from './types'

// ---------------------------------------------------------------------------
// 场景解析
// ---------------------------------------------------------------------------

/**
 * 解析 VITE_MOCK_SCENARIO 环境变量为 MockScenario。
 *
 * 未设置或值非法时默认为 'normal'。
 */
function resolveMockScenario(): MockScenario {
  const raw = import.meta.env.VITE_MOCK_SCENARIO
  if (raw === 'normal' || raw === 'boundary' || raw === 'error') {
    return raw
  }
  return 'normal'
}

/**
 * 当前 mock 场景（模块加载时确定，运行时不可变）。
 */
export const mockScenario: MockScenario = resolveMockScenario()

// ---------------------------------------------------------------------------
// 数据访问函数
// ---------------------------------------------------------------------------

/**
 * 获取当前场景的 mock 数据。
 *
 * - normal: 返回 normalMockData
 * - boundary: 返回 boundaryMockData（空状态）
 * - error: 返回 normalMockData（error 场景仍使用正常数据，仅在 shouldFail 时抛错）
 *
 * @returns 当前场景的 MockData
 */
export function getMockData(): MockData {
  switch (mockScenario) {
    case 'boundary':
      return boundaryMockData
    case 'error':
      // error 场景使用 normal 数据作为基础，shouldFail 控制 API 抛错
      return normalMockData
    case 'normal':
    default:
      return normalMockData
  }
}

/**
 * 检查指定 API 在 error 场景下是否应抛错。
 *
 * 仅当 mockScenario 为 'error' 且 apiName 在 errorScenarioConfig.failApis 中时返回 true。
 * 其他场景始终返回 false。
 *
 * @param apiName — API 名称（如 'listThreads'、'listMessages'）
 * @returns 是否应抛错
 */
export function shouldFail(apiName: string): boolean {
  if (mockScenario !== 'error') return false
  return errorScenarioConfig.failApis.includes(apiName)
}

/**
 * 生成 mock 错误实例。
 *
 * 在 error 场景下，shouldFail 返回 true 时调用此函数获取 Error。
 * 错误信息优先从 errorScenarioConfig.errorMessages 读取，未配置时使用默认信息。
 *
 * @param apiName — API 名称
 * @returns Error 实例
 */
export function getMockError(apiName: string): Error {
  const message = errorScenarioConfig.errorMessages?.[apiName]
    ?? `mock: ${apiName} 请求失败（error 场景）`
  return new Error(message)
}
