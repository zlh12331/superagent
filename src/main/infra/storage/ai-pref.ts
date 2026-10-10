// ai-pref.ts：AI 域偏好（settings 表 ai 键）——当前只承载默认模型选择
import { readSetting } from './settings-pref';

const AI_SETTINGS_KEY = 'ai';

/** 已选默认模型 id（未选/损坏返回 undefined——调用方回落内置默认模型） */
export function readSelectedModelId(): string | undefined {
  try {
    const raw = readSetting(AI_SETTINGS_KEY) as { defaultModel?: unknown } | undefined;
    const modelId = raw?.defaultModel;
    return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
  } catch {
    return undefined;
  }
}
