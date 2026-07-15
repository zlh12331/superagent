/**
 * Error 场景配置
 *
 * 定义 error 场景下哪些 API 应抛错。
 * error 场景仍使用 normalMockData 作为基础数据，
 * 仅在 shouldFail 返回 true 时抛错（保证部分 API 仍可调用）。
 *
 * ## 覆盖的 API
 *
 * 涵盖主要的数据读取 API（listThreads/listMessages/getAccount/getConfig/listMcpServers），
 * 用于调试错误处理 UI（如加载失败提示、重试按钮等）。
 *
 * @see src/lib/codex/mock/types.ts — ErrorScenarioConfig 接口定义
 */

import type { ErrorScenarioConfig } from '../types'

/**
 * Error 场景配置
 *
 * failApis 中的 API 名称应与各 API 文件 shouldFail 调用的参数一致。
 * 未在 failApis 中列出的 API 正常返回数据。
 */
export const errorScenarioConfig: ErrorScenarioConfig = {
  failApis: [
    'listThreads',
    'listMessages',
    'getAccount',
    'getConfig',
    'listMcpServers',
  ],
  errorMessages: {
    listThreads: 'mock: thread/list 请求失败（error 场景）',
    listMessages: 'mock: listMessages 请求失败（error 场景）',
    getAccount: 'mock: getAccount 请求失败（error 场景）',
    getConfig: 'mock: getConfig 请求失败（error 场景）',
    listMcpServers: 'mock: listMcpServers 请求失败（error 场景）',
  },
}
