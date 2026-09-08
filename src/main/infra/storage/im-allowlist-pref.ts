// src/main/infra/storage/im-allowlist-pref.ts
// IM 群聊执行白名单持久化（app_settings 表，fail closed）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-08 安全审计修复）：
// IM 入站此前只检查审批模式，不校验发送者——任何能给机器人发消息的人
// （群聊任意成员）都能驱动 agent 执行工具，yolo 模式下可读本机文件并回发群聊。
//
// 策略：
// - 私聊（channelType !== 'group'）默认放行（只有 owner 本人能私聊机器人）
// - 群聊必须显式登记 `${channel}:${chatId}` 才执行（默认拒绝）
//
// 存储：复用 app_settings 表（key = 'im.allowedGroups'），与设置体系同源，
// 不新增表/迁移；主进程直接读 SQLite，无需经渲染层。
// ──────────────────────────────────────────────────────────────

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
