import { readSetting, writeSetting } from './settings-pref';

/** 设置 key（受 KEY_PATTERN 约束：字母开头 + 字母数字/点/下划线/连字符） */
const IM_ALLOWED_GROUPS_KEY = 'im.allowedGroups';

/**
 * 读取群聊白名单（同步；损坏/类型不符视为空列表 = 全部拒绝）
 */
export function readImAllowedGroups(): readonly string[] {
  const raw = readSetting(IM_ALLOWED_GROUPS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/**
 * 判断某群聊是否被授权执行（fail closed：未登记即拒绝）
 *
 * @param channel 渠道 kind
 * @param chatId 群聊标识
 */
export function isImGroupAllowed(channel: string, chatId: string): boolean {
  return readImAllowedGroups().includes(`${channel}:${chatId}`);
}

/** 覆盖写入群聊白名单（去重 + 去空；供 IPC/设置页调用） */
export function writeImAllowedGroups(groups: readonly string[]): void {
  const normalized = [...new Set(groups.filter((item) => item.length > 0))];
  writeSetting(IM_ALLOWED_GROUPS_KEY, normalized);
}
