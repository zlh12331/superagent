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

import { useEffect, useRef } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { useSettingsStore } from '@/stores/persistent/settings-store';

interface ShortcutHandlers {
  readonly onCommandPalette: () => void;
  readonly onSaveFile: () => void;
  readonly onSearchFile: () => void;
  readonly onToggleTheme: () => void;
  readonly onOpenSettings: () => void;
  readonly onNewSession: () => void;
  /** 打开快捷键帮助对话框（'?' 键，非用户可配置） */
  readonly onOpenShortcutHelp?: () => void;
  /** 切换左侧栏（Ctrl+B / Ctrl+1，对齐参考项目 toggle-left-sidebar 快捷键） */
  readonly onToggleSidebar?: () => void;
  /** 切换右侧栏（Ctrl+J / Ctrl+2，对齐参考项目 toggle-right-sidebar 快捷键） */
  readonly onToggleRightPanel?: () => void;
  /** 打开终端（Ctrl+`，对齐参考项目 codex.openTerminal 快捷键） */
  readonly onOpenTerminal?: () => void;
  /** 返回上一视图（Alt+←，对齐参考项目 backBtn 快捷键） */
  readonly onBack?: () => void;
  /** 界面放大（Ctrl/Cmd + =，固定键；35 号） */
  readonly onZoomIn?: () => void;
  /** 界面缩小（Ctrl/Cmd + -，固定键；35 号） */
  readonly onZoomOut?: () => void;
  /** 界面缩放重置 100%（Ctrl/Cmd + 0，固定键；35 号） */
  readonly onZoomReset?: () => void;
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

/**
 * 全局快捷键 hook：从设置读 shortcut 配置 → react-hotkeys 绑定
 * （preventDefault + 表单内不触发；handlers 经 ref 转发避免重复绑定）
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const shortcuts = useSettingsStore((s) => s.shortcuts);

  // 最新 handlers 引用（避免依赖变化导致重复绑定/解绑）
  // 赋值放 effect：render 期写 ref 是 React 反模式，React Compiler 会因此跳过优化本 hook；
  // 事件回调总在 commit 之后触发，effect 内赋值语义等价
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  // 纯派生，交给 React Compiler 记忆化；下游 useHotkeys 依赖的是字符串字段（按值比较）
  const hotkeys = {
    commandPalette: toHotkeyString(parseShortcut(shortcuts.commandPalette)),
    saveFile: toHotkeyString(parseShortcut(shortcuts.saveFile)),
    searchFile: toHotkeyString(parseShortcut(shortcuts.searchFile)),
    toggleTheme: toHotkeyString(parseShortcut(shortcuts.toggleTheme)),
    openSettings: toHotkeyString(parseShortcut(shortcuts.openSettings)),
    newSession: toHotkeyString(parseShortcut(shortcuts.newSession)),
  };

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

  // 快捷键帮助：'?' / F1 固定键（对齐参考项目 ShortcutHelpDialog 触发方式）
  // react-hotkeys-hook v5 按 event.code 匹配：物理键 '/' 的 code 是 'Slash'（shift+Slash = '?'）
  useHotkeys('shift+Slash', () => handlersRef.current.onOpenShortcutHelp?.(), HOTKEY_OPTIONS, []);
  useHotkeys('f1', () => handlersRef.current.onOpenShortcutHelp?.(), HOTKEY_OPTIONS, []);

  // ⌘K 打开命令面板（与 ⌘P 等价，对齐参考项目 toggle-command-palette ⌘+K）
  useHotkeys('ctrl+k,meta+k', () => handlersRef.current.onCommandPalette(), HOTKEY_OPTIONS, []);

  // Alt+← 返回上一视图（对齐参考项目 backBtn：Alt+ArrowLeft）
  useHotkeys('alt+ArrowLeft', () => handlersRef.current.onBack?.(), HOTKEY_OPTIONS, []);

  // 面板切换：Ctrl/Cmd + B / 1（左面板）、Ctrl/Cmd + J / 2（右面板）
  // 对齐参考项目 toggle-left-sidebar（⌘1/⌘B/⌘\）与 toggle-right-sidebar（⌘2/⌘J）
  // 表单元素内不触发（库默认），避免输入框中 Ctrl+B 等快捷键干扰
  useHotkeys(
    'ctrl+b,meta+b,ctrl+1,meta+1',
    () => handlersRef.current.onToggleSidebar?.(),
    HOTKEY_OPTIONS,
    [],
  );
  useHotkeys(
    'ctrl+j,meta+j,ctrl+2,meta+2',
    () => handlersRef.current.onToggleRightPanel?.(),
    HOTKEY_OPTIONS,
    [],
  );

  // 打开终端（Ctrl/Cmd + `，对齐参考项目 codex.openTerminal）
  // react-hotkeys-hook v5 按 event.code 匹配：物理键 ` 的 code 是 'Backquote'
  useHotkeys(
    'ctrl+Backquote,meta+Backquote',
    () => handlersRef.current.onOpenTerminal?.(),
    HOTKEY_OPTIONS,
    [],
  );

  // 界面缩放（35 号：Ctrl/Cmd + = / - / 0，固定键区）
  // v5 按 event.code 匹配（实测源码归一化剥 key/digit/numpad 前缀）：
  // '=' 物理键 code = 'Equal'（+ 与 = 同键，Shift 变体同绑）；
  // '-' code = 'Minus'；'0' 写 Digit0 或 0 均可（归一后同为 '0'，用裸 0 更直观）。
  useHotkeys(
    'ctrl+Equal,ctrl+shift+Equal,meta+Equal,meta+shift+Equal',
    () => handlersRef.current.onZoomIn?.(),
    HOTKEY_OPTIONS,
    [],
  );
  useHotkeys('ctrl+Minus,meta+Minus', () => handlersRef.current.onZoomOut?.(), HOTKEY_OPTIONS, []);
  useHotkeys('ctrl+0,meta+0', () => handlersRef.current.onZoomReset?.(), HOTKEY_OPTIONS, []);
}
