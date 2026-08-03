// src/renderer/hooks/use-keyboard-shortcuts.ts
// 全局快捷键 hook（react-hotkeys-hook 实现）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一管理全局快捷键监听
// - 解析快捷键配置字符串（如 "Meta+P"）为 react-hotkeys-hook 格式
// - 根据配置动态绑定快捷键事件
// - 支持自定义快捷键映射
//
// 设计：
// - 基于 react-hotkeys-hook 的 useHotkeys（事件绑定/解绑/表单隔离均由库处理）
// - 配置驱动：快捷键绑定从 settings-store 读取
// - 行为：默认在 input/textarea/contentEditable 内不触发（库默认，与原实现一致）
// ──────────────────────────────────────────────────────────────

import { useMemo, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { useSettingsStore } from '@/stores/persistent/settings-store';

interface ShortcutHandlers {
  readonly onCommandPalette: () => void;
  readonly onSaveFile: () => void;
  readonly onSearchFile: () => void;
  readonly onToggleTheme: () => void;
  readonly onOpenSettings: () => void;
  readonly onNewSession: () => void;
}

interface ParsedShortcut {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split('+');
  const keyParts = parts.filter((p) => p.length > 0);

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = '';

  for (const part of keyParts) {
    const upper = part.toUpperCase();
    switch (upper) {
      case 'CTRL':
      case 'CONTROL':
        ctrl = true;
        break;
      case 'ALT':
      case 'OPTION':
        alt = true;
        break;
      case 'SHIFT':
        shift = true;
        break;
      case 'META':
      case 'CMD':
      case 'COMMAND':
        meta = true;
        break;
      default:
        key = upper;
        break;
    }
  }

  return { key, ctrl, alt, shift, meta };
}

/** ParsedShortcut → react-hotkeys-hook 键串（"Meta+P" → "meta+p"） */
function toHotkeyString(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('ctrl');
  if (parsed.alt) parts.push('alt');
  if (parsed.shift) parts.push('shift');
  if (parsed.meta) parts.push('meta');
  parts.push(parsed.key.toLowerCase());
  return parts.join('+');
}

/** useHotkeys 公共选项：阻止默认行为，表单元素内不触发（与原实现一致） */
const HOTKEY_OPTIONS = { preventDefault: true } as const;

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const shortcuts = useSettingsStore((s) => s.shortcuts);

  // 最新 handlers 引用（避免依赖变化导致重复绑定/解绑）
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const hotkeys = useMemo(
    () => ({
      commandPalette: toHotkeyString(parseShortcut(shortcuts.commandPalette)),
      saveFile: toHotkeyString(parseShortcut(shortcuts.saveFile)),
      searchFile: toHotkeyString(parseShortcut(shortcuts.searchFile)),
      toggleTheme: toHotkeyString(parseShortcut(shortcuts.toggleTheme)),
      openSettings: toHotkeyString(parseShortcut(shortcuts.openSettings)),
      newSession: toHotkeyString(parseShortcut(shortcuts.newSession)),
    }),
    [shortcuts],
  );

  // 逐个绑定：handlers 经 ref 取最新，key 变化触发重新绑定
  useHotkeys(hotkeys.commandPalette, () => handlersRef.current.onCommandPalette(), HOTKEY_OPTIONS, [
    hotkeys.commandPalette,
  ]);
  useHotkeys(hotkeys.saveFile, () => handlersRef.current.onSaveFile(), HOTKEY_OPTIONS, [
    hotkeys.saveFile,
  ]);
  useHotkeys(hotkeys.searchFile, () => handlersRef.current.onSearchFile(), HOTKEY_OPTIONS, [
    hotkeys.searchFile,
  ]);
  useHotkeys(hotkeys.toggleTheme, () => handlersRef.current.onToggleTheme(), HOTKEY_OPTIONS, [
    hotkeys.toggleTheme,
  ]);
  useHotkeys(hotkeys.openSettings, () => handlersRef.current.onOpenSettings(), HOTKEY_OPTIONS, [
    hotkeys.openSettings,
  ]);
  useHotkeys(hotkeys.newSession, () => handlersRef.current.onNewSession(), HOTKEY_OPTIONS, [
    hotkeys.newSession,
  ]);
}
