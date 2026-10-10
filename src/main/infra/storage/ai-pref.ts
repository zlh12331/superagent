import { readSetting } from './settings-pref';

const AI_SETTINGS_KEY = 'ai';

export function readSelectedModelId(): string | undefined {
  try {
    const raw = readSetting(AI_SETTINGS_KEY) as { defaultModel?: unknown } | undefined;
    const modelId = raw?.defaultModel;
    return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
  } catch {
    return undefined;
  }
}
