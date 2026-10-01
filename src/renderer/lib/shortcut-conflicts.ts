// src/renderer/lib/shortcut-conflicts.ts
// 快捷键冲突检测纯函数（36 号 C：录键冲突 + 固定键抢占）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 归一化快捷键串用于比较（Meta ≡ Ctrl 跨平台等价、修饰符排序、主键小写）
// - 录入值与「其他自定义键 + 固定键」判定冲突，供 shortcuts-section 拒绝写入
//
// 设计：
// - 只用于比较，不回写存储格式（存储仍为 "Meta+P" 原始形态）
// - 固定键清单在 use-keyboard-shortcuts.ts 导出（与 useHotkeys 绑定同源维护）
// - 空串（解绑）/ 纯修饰键 → 无冲突（normalize 返回 null）
// ──────────────────────────────────────────────────────────────

import { FIXED_SHORTCUT_CONFLICTS } from '@/hooks/use-keyboard-shortcuts';
import type { KeyboardShortcuts } from '@/stores/persistent/settings-store';

/** 可自定义快捷键键名清单（KeyboardShortcuts 的全部字段） */
export const CUSTOM_SHORTCUT_KEYS = [
  'commandPalette',
  'saveFile',
  'searchFile',
  'toggleTheme',
  'openSettings',
  'newSession',
] as const;

/** 可自定义快捷键键名类型 */
export type CustomShortcutKey = (typeof CUSTOM_SHORTCUT_KEYS)[number];

/** 冲突判定结果：与固定键冲突（带动作名 i18n key）或与其他自定义键冲突（带键名） */
export type ShortcutConflict =
  | { readonly kind: 'fixed'; readonly labelKey: string }
  | { readonly kind: 'custom'; readonly key: CustomShortcutKey };

/**
 * 归一化快捷键串为比较形态
 *
 * - 修饰符：Meta/Cmd/Command ≡ Ctrl/Control（跨平台等价，V3）；Alt ≡ Option
 * - 排序：alt < ctrl < shift；主键小写
 * - 空串（解绑）/ 纯修饰键（无主键）→ null（永不冲突，V4）
 *
 * @example normalizeShortcutForCompare('Meta+Shift+T') === 'ctrl+shift+t'
 */
export function normalizeShortcutForCompare(shortcut: string): string | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let alt = false;
  let ctrl = false;
  let shift = false;
  let key = '';
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'meta':
      case 'cmd':
      case 'command':
      case 'ctrl':
      case 'control':
        ctrl = true;
        break;
      case 'alt':
      case 'option':
        alt = true;
        break;
      case 'shift':
        shift = true;
        break;
      default:
        key = part.toLowerCase();
    }
  }
  if (key === '') {
    return null;
  }
  const modifiers = [alt ? 'alt' : '', ctrl ? 'ctrl' : '', shift ? 'shift' : ''].filter(
    (mod) => mod !== '',
  );
  return [...modifiers, key].join('+');
}

/**
 * 判定录入值是否与其他快捷键冲突
 *
 * 固定键优先（抢占系统行为代价最高）；与自身当前值相同的重录放行（V5，
 * excludeKey 排除自身）。返回 null 表示无冲突。
 *
 * @param next 录入的新快捷键串（存储原始形态）
 * @param excludeKey 正在编辑的自定义键（自身排除）
 * @param shortcuts 当前全部自定义键值
 */
export function findShortcutConflict(
  next: string,
  excludeKey: CustomShortcutKey,
  shortcuts: KeyboardShortcuts,
): ShortcutConflict | null {
  const normalizedNext = normalizeShortcutForCompare(next);
  if (normalizedNext === null) {
    return null;
  }
  for (const fixed of FIXED_SHORTCUT_CONFLICTS) {
    if (fixed.match === normalizedNext) {
      return { kind: 'fixed', labelKey: fixed.labelKey };
    }
  }
  for (const key of CUSTOM_SHORTCUT_KEYS) {
    if (key === excludeKey) {
      continue;
    }
    if (normalizeShortcutForCompare(shortcuts[key]) === normalizedNext) {
      return { kind: 'custom', key };
    }
  }
  return null;
}
