// src/renderer/components/common/CommandPalette.tsx
// 命令面板 · ⌘P 全局快捷搜索（cmdk + fuse.js 实现）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 全局命令面板（⌘P 触发）：搜索 + 键盘导航 + 执行命令
// - 基础命令：新建会话 / 切换主题 / 打开设置
// - 文件命令：动态派生自文件树，点击打开文件
// - 会话命令：动态派生自会话列表，点击切换激活会话并跳转
//
// 设计（cmdk 重写，2026-08）：
// - 键盘导航（↑↓ / Enter / Esc）与选中态由 cmdk 内置处理（data-selected）
// - 模糊搜索用 fuse.js（标题 + 分组字段），替代手写 includes 过滤
// - 组件 props 接口不变（open / onOpenChange 受控），AppShell 零改动
// ──────────────────────────────────────────────────────────────

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk';
import Fuse from 'fuse.js';
import { FileText, MessageSquare, Moon, Plus, Search, Settings, Sun } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router';

import { useSessionsQuery } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { useTheme } from '@/providers/ThemeProvider';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

interface CommandPaletteProps {
  /** 是否打开 */
  open: boolean;
  /** 打开/关闭回调 */
  onOpenChange: (open: boolean) => void;
}

interface CommandItemData {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly icon: typeof Plus;
  readonly shortcut?: string;
  readonly action: () => void;
}

/** fuse.js 搜索阈值（0 = 完全匹配，0.4 = 容忍拼写/顺序差异） */
const FUSE_THRESHOLD = 0.4;

/**
 * 命令面板组件（cmdk + fuse.js）
 *
 * 受控模式：由父组件（AppShell）管理 open 状态 + ⌘P 快捷键。
 * cmdk 负责键盘导航与选中态；fuse.js 负责命令模糊搜索。
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): ReactElement | null {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  // 本地化文案
  const { t } = useTranslation();
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  const { data: sessionsData } = useSessionsQuery();

  const rootPath = useFileTreeStore((state) => state.rootPath);
  const getAllFilePaths = useFileTreeStore((state) => state.getAllFilePaths);
  const openFile = useFileViewerStore((state) => state.openFile);

  const [query, setQuery] = useState('');
  // 全局 UI store：设置对话框入口（命令面板 / Topbar / 错误动作共享）
  const openSettings = useUiStore((state) => state.openSettings);

  // 命令列表（依赖外部状态派生；React Compiler 自动缓存）
  // - 操作组：新建会话 / 切换主题 / 打开设置
  // - 文件组：动态派生自文件树，点击打开文件
  // - 会话组：动态派生自 useSessionsQuery 的会话列表，点击切换激活会话并跳转
  const commands = ((): readonly CommandItemData[] => {
    const closePalette = (): void => onOpenChange(false);
    const baseCommands: readonly CommandItemData[] = [
      {
        id: 'new-chat',
        section: t('palette.sectionActions'),
        title: t('palette.newChat'),
        icon: Plus,
        shortcut: '⌘N',
        action: () => {
          clearActiveSession();
          enterWelcomeMode(null);
          navigate(ROUTES.home);
          closePalette();
        },
      },
      {
        id: 'toggle-theme',
        section: t('palette.sectionActions'),
        title:
          resolvedTheme === 'dark' ? t('palette.toggleThemeLight') : t('palette.toggleThemeDark'),
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        action: () => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          closePalette();
        },
      },
      {
        id: 'open-settings',
        section: t('palette.sectionActions'),
        title: t('palette.openSettings'),
        icon: Settings,
        action: () => {
          openSettings();
          closePalette();
        },
      },
    ];

    // 文件打开命令：从文件树派生（最多 50 条避免列表过长）
    const fileCommands: CommandItemData[] = [];
    if (rootPath !== null) {
      const filePaths = getAllFilePaths();
      for (const filePath of filePaths.slice(0, 50)) {
        const relativePath = filePath.startsWith(`${rootPath}/`)
          ? filePath.slice(rootPath.length + 1)
          : filePath.startsWith(`${rootPath}\\`)
            ? filePath.slice(rootPath.length + 1)
            : filePath;
        fileCommands.push({
          id: `file:${filePath}`,
          section: t('palette.sectionFiles'),
          title: relativePath,
          icon: FileText,
          action: () => {
            openFile(filePath);
            closePalette();
          },
        });
      }
    }

    // 会话切换命令：从 useSessionsQuery 派生（按 updatedAt 倒序，最多 20 条避免列表过长）
    const sessions = sessionsData?.sessions ?? [];
    const sessionCommands: readonly CommandItemData[] = sessions.slice(0, 20).map((session) => ({
      id: `session:${session.id}`,
      section: t('palette.sectionSessions'),
      title: session.title.length > 0 ? session.title : t('palette.unnamedSession'),
      icon: MessageSquare,
      action: () => {
        setActiveSession(session.id);
        navigate(ROUTES.chatPath(session.id));
        closePalette();
      },
    }));

    return [...baseCommands, ...fileCommands, ...sessionCommands];
  })();

  // fuse.js 模糊搜索（标题 + 分组字段；空查询时返回全部；React Compiler 自动缓存）
  const fuse = new Fuse([...commands], {
    keys: ['title', 'section'],
    threshold: FUSE_THRESHOLD,
    ignoreLocation: true,
  });
  const filtered = ((): readonly CommandItemData[] => {
    const q = query.trim();
    if (q.length === 0) {
      return commands;
    }
    return fuse.search(q).map((result) => result.item);
  })();

  if (!open) return null;

  return (
    <div
      className="palette-overlay show"
      role="dialog"
      aria-label={t('topbar.commandPalette')}
      aria-modal="true"
      onClick={(e) => {
        // 点击遮罩空白处关闭
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      onKeyDown={(e) => {
        // 键盘可达性：Esc 关闭（cmdk 内部处理 Esc 时也会调 onOpenChange）
        if (e.key === 'Escape') {
          e.preventDefault();
          onOpenChange(false);
        }
      }}
    >
      <Command className="palette" shouldFilter={false}>
        <div className="palette-input-wrap">
          <Search className="size-4" strokeWidth={2} />
          <CommandInput
            className="palette-input"
            placeholder={t('palette.searchPlaceholder')}
            aria-label={t('palette.searchLabel')}
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
        </div>
        <CommandList className="palette-results">
          <CommandEmpty className="palette-empty">{t('common.noResults')}</CommandEmpty>
          {Array.from(new Set(filtered.map((cmd) => cmd.section))).map((section) => (
            <CommandGroup key={section} heading={section}>
              {filtered
                .filter((cmd) => cmd.section === section)
                .map((cmd) => {
                  const Icon = cmd.icon;
                  return (
                    <CommandItem
                      key={cmd.id}
                      className="palette-item"
                      value={`${section} ${cmd.title}`}
                      onSelect={() => cmd.action()}
                    >
                      <span className="pi-icon">
                        <Icon className="size-3" strokeWidth={2} />
                      </span>
                      <span className="pi-main">
                        <span className="pi-title">{cmd.title}</span>
                      </span>
                      {cmd.shortcut !== undefined && (
                        <span className="pi-shortcut">{cmd.shortcut}</span>
                      )}
                    </CommandItem>
                  );
                })}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd> {t('palette.navigate')}
          </span>
          <span>
            <kbd>⏎</kbd> {t('palette.select')}
          </span>
          <span>
            <kbd>esc</kbd> {t('common.close')}
          </span>
        </div>
      </Command>
    </div>
  );
}
