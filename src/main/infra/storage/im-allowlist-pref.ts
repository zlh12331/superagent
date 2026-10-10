import { readSetting, writeSetting } from './settings-pref';

const IM_ALLOWED_GROUPS_KEY = 'im.allowedGroups';

export function readImAllowedGroups(): readonly string[] {
  const raw = readSetting(IM_ALLOWED_GROUPS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function isImGroupAllowed(channel: string, chatId: string): boolean {
  return readImAllowedGroups().includes(`${channel}:${chatId}`);
}

export function writeImAllowedGroups(groups: readonly string[]): void {
  const normalized = [...new Set(groups.filter((item) => item.length > 0))];
  writeSetting(IM_ALLOWED_GROUPS_KEY, normalized);
}
