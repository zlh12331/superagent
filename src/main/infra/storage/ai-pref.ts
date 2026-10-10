import { readSetting } from './settings-pref';

/** app_settings 中的 AI 设置键（渲染层 settings-store 的结构契约） */
const AI_SETTINGS_KEY = 'ai';

/**
 * 读取用户选定的默认模型 id
 *
 * @returns 模型 id；未设置 / 非法值 / 读取失败均返回 undefined（调用方回落默认模型）
 */
export function readSelectedModelId(): string | undefined {
  try {
    const raw = readSetting(AI_SETTINGS_KEY) as { defaultModel?: unknown } | undefined;
    const modelId = raw?.defaultModel;
    return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
  } catch {
    return undefined;
  }
}
