// src/renderer/hooks/use-keyboard-shortcuts.ts
// 全局快捷键 hook
// ──────────────────────────────────────────────────────────────
// 职责：
// - 统一管理全局快捷键监听
// - 解析快捷键配置字符串（如 "Meta+P"）
// - 根据配置动态绑定快捷键事件
// - 支持自定义快捷键映射
//
// 设计：
// - 单例模式：全局只注册一次 keydown 监听
// - 配置驱动：快捷键绑定从 settings-store 读取
// - 优先级：编辑器内的快捷键优先于全局快捷键
// ──────────────────────────────────────────────────────────────

import { useEffect, useMemo } from 'react';

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

function matchesShortcut(e: KeyboardEvent, parsed: ParsedShortcut): boolean {
  const key = e.key.toUpperCase();
  const code = e.code.toUpperCase();

  const keyMatches = key === parsed.key || code.endsWith(`_${parsed.key}`);

  if (!keyMatches) return false;

  if (parsed.ctrl && !e.ctrlKey) return false;
  if (parsed.alt && !e.altKey) return false;
  if (parsed.shift && !e.shiftKey) return false;
  if (parsed.meta && !e.metaKey) return false;

  if (!parsed.ctrl && e.ctrlKey) return false;
  if (!parsed.alt && e.altKey) return false;
  if (!parsed.shift && e.shiftKey) return false;
  if (!parsed.meta && e.metaKey) return false;

  return true;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const shortcuts = useSettingsStore((s) => s.shortcuts);

  const parsedShortcuts = useMemo(() => {
    return {
      commandPalette: parseShortcut(shortcuts.commandPalette),
      saveFile: parseShortcut(shortcuts.saveFile),
      searchFile: parseShortcut(shortcuts.searchFile),
      toggleTheme: parseShortcut(shortcuts.toggleTheme),
      openSettings: parseShortcut(shortcuts.openSettings),
      newSession: parseShortcut(shortcuts.newSession),
    };
  }, [shortcuts]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (isInput && !e.metaKey && !e.ctrlKey) {
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.commandPalette)) {
        e.preventDefault();
        handlers.onCommandPalette();
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.saveFile)) {
        e.preventDefault();
        handlers.onSaveFile();
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.searchFile)) {
        e.preventDefault();
        handlers.onSearchFile();
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.toggleTheme)) {
        e.preventDefault();
        handlers.onToggleTheme();
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.openSettings)) {
        e.preventDefault();
        handlers.onOpenSettings();
        return;
      }

      if (matchesShortcut(e, parsedShortcuts.newSession)) {
        e.preventDefault();
        handlers.onNewSession();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers, parsedShortcuts]);
}
