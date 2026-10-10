// im-allowlist-pref.ts：IM 渠道准入白名单（settings 表 im.allowedGroups 键）——
// 只有名单内的「渠道:会话」允许触发 Agent 回合（防任意 IM 用户拉起本机 Agent）
import { readSetting, writeSetting } from './settings-pref';

const IM_ALLOWED_GROUPS_KEY = 'im.allowedGroups';

/** 读白名单（格式/类型不符的条目剔除） */
export function readImAllowedGroups(): readonly string[] {
  const raw = readSetting(IM_ALLOWED_GROUPS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 该渠道会话是否在准入名单内 */
export function isImGroupAllowed(channel: string, chatId: string): boolean {
  return readImAllowedGroups().includes(`${channel}:${chatId}`);
}

/** 整表覆写（去重去空） */
export function writeImAllowedGroups(groups: readonly string[]): void {
  const normalized = [...new Set(groups.filter((item) => item.length > 0))];
  writeSetting(IM_ALLOWED_GROUPS_KEY, normalized);
}
