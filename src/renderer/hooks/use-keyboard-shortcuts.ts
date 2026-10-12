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
 * 固定键冲突清单（36 号 C：录键冲突检测用）
 *
 * match 是 **e.key 归一化形态**（normalizeShortcutForCompare：修饰符 Meta ≡ Ctrl、
 * 排序 alt<ctrl<shift、主键小写），与上方/下方 useHotkeys 的固定绑定**同源维护**——
 * 增删固定键必须两处同步（shortcut-conflicts.test.ts 锚定内容）。
 * 绑定串是 event.code 形态（v5 按 code 匹配），code→key 的差异已在 match 中
 * 人工换算（Slash→? / Equal→= / Minus→- / Backquote→`）。注意 'ctrl+shift++'
 * （e.key '+' 的 shift 变体）**不在清单**：'+' 主键在 '+' 分隔的存储格式中无法
 * 往返（normalize 得到 null），录入侧本就产生损坏串——由 store 格式约束排除。
 */
export const FIXED_SHORTCUT_CONFLICTS: readonly {
  /** 归一化匹配串（与录键结果比较） */
  readonly match: string;
  /** 冲突提示用的动作名 i18n key */
  readonly labelKey: string;
}[] = [
  { match: 'shift+?', labelKey: 'shortcutHelp.item.openShortcutHelp' },
  { match: 'f1', labelKey: 'shortcutHelp.item.openShortcutHelp' },
  { match: 'ctrl+k', labelKey: 'shortcutHelp.item.openCommandPalette' },
  { match: 'alt+arrowleft', labelKey: 'shortcutHelp.item.back' },
  { match: 'ctrl+b', labelKey: 'shortcutHelp.item.toggleSidebar' },
  { match: 'ctrl+1', labelKey: 'shortcutHelp.item.toggleSidebar' },
  { match: 'ctrl+j', labelKey: 'shortcutHelp.item.toggleRightPanel' },
  { match: 'ctrl+2', labelKey: 'shortcutHelp.item.toggleRightPanel' },
  { match: 'ctrl+`', labelKey: 'shortcutHelp.item.openTerminal' },
  { match: 'ctrl+=', labelKey: 'shortcutHelp.item.zoomIn' },
  { match: 'ctrl+shift+=', labelKey: 'shortcutHelp.item.zoomIn' },
  { match: 'ctrl+-', labelKey: 'shortcutHelp.item.zoomOut' },
  { match: 'ctrl+0', labelKey: 'shortcutHelp.item.zoomReset' },
];

/**
 * 全局快捷键 hook：从设置读 shortcut 配置 → react-hotkeys 绑定
 * （preventDefault + 表单内不触发；handlers 经 ref 转发避免重复绑定）
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const shortcuts = useSettingsStore((s) => s.shortcuts);

  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const hotkeys = {
    commandPalette: toHotkeyString(parseShortcut(shortcuts.commandPalette)),
    saveFile: toHotkeyString(parseShortcut(shortcuts.saveFile)),
    searchFile: toHotkeyString(parseShortcut(shortcuts.searchFile)),
    toggleTheme: toHotkeyString(parseShortcut(shortcuts.toggleTheme)),
    openSettings: toHotkeyString(parseShortcut(shortcuts.openSettings)),
    newSession: toHotkeyString(parseShortcut(shortcuts.newSession)),
  };

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

  useHotkeys('shift+Slash', () => handlersRef.current.onOpenShortcutHelp?.(), HOTKEY_OPTIONS, []);
  useHotkeys('f1', () => handlersRef.current.onOpenShortcutHelp?.(), HOTKEY_OPTIONS, []);

  useHotkeys('ctrl+k,meta+k', () => handlersRef.current.onCommandPalette(), HOTKEY_OPTIONS, []);

  useHotkeys('alt+ArrowLeft', () => handlersRef.current.onBack?.(), HOTKEY_OPTIONS, []);

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

  useHotkeys(
    'ctrl+Backquote,meta+Backquote',
    () => handlersRef.current.onOpenTerminal?.(),
    HOTKEY_OPTIONS,
    [],
  );

  useHotkeys(
    'ctrl+Equal,ctrl+shift+Equal,meta+Equal,meta+shift+Equal',
    () => handlersRef.current.onZoomIn?.(),
    HOTKEY_OPTIONS,
    [],
  );
  useHotkeys('ctrl+Minus,meta+Minus', () => handlersRef.current.onZoomOut?.(), HOTKEY_OPTIONS, []);
  useHotkeys('ctrl+0,meta+0', () => handlersRef.current.onZoomReset?.(), HOTKEY_OPTIONS, []);
}
