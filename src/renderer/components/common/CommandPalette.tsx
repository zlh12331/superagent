// src/renderer/components/common/CommandPalette.tsx
// 命令面板 · ⌘P 全局快捷搜索
// ──────────────────────────────────────────────────────────────
// 职责：
// - 全局命令面板（⌘P 触发）：搜索 + 键盘导航 + 执行命令
// - 基础命令：新建会话 / 切换主题 / 打开设置
// - 对齐原型 .palette-overlay + .palette 结构
//
// 设计（对齐原型 docs/prototype/prototype-v2.html §命令面板）：
// - .palette-overlay > .palette > input-wrap + results + foot
// - 搜索过滤命令列表（标题模糊匹配）
// - ↑↓ 键盘导航 + Enter 执行 + Esc 关闭
// ──────────────────────────────────────────────────────────────

import { FileText, MessageSquare, Moon, Plus, Search, Settings, Sun } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';

import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useSessionsQuery } from '@/hooks/use-sessions';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

interface CommandPaletteProps {
  /** 是否打开 */
  open: boolean;
  /** 打开/关闭回调 */
  onOpenChange: (open: boolean) => void;
}

interface Command {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly icon: typeof Plus;
  readonly shortcut?: string;
  readonly action: () => void;
}

/**
 * 命令面板组件
 *
 * 受控模式：由父组件（AppShell）管理 open 状态 + ⌘P 快捷键。
 * 内部管理搜索 query + 键盘选中 activeIndex + 设置弹窗 settingsOpen。
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): ReactElement | null {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  const { data: sessionsData } = useSessionsQuery();

  const rootPath = useFileTreeStore((state) => state.rootPath);
  const getAllFilePaths = useFileTreeStore((state) => state.getAllFilePaths);
  const openFile = useFileViewerStore((state) => state.openFile);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 关闭时重置状态
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 命令列表（依赖外部状态，需 useMemo 避免重建）
  // - 操作组：新建会话 / 切换主题 / 打开设置
  // - 文件组：动态派生自文件树，点击打开文件
  // - 会话组：动态派生自 useSessionsQuery 的会话列表，点击切换激活会话并跳转
  const commands = useMemo<readonly Command[]>(() => {
    const closePalette = (): void => onOpenChange(false);
    const baseCommands: readonly Command[] = [
      {
        id: 'new-chat',
        section: '操作',
        title: '新建会话',
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
        section: '操作',
        title: resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题',
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        action: () => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          closePalette();
        },
      },
      {
        id: 'open-settings',
        section: '操作',
        title: '打开设置',
        icon: Settings,
        action: () => {
          setSettingsOpen(true);
          closePalette();
        },
      },
    ];

    // 文件打开命令：从文件树派生（最多 50 条避免列表过长）
    const fileCommands: Command[] = [];
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
          section: '文件',
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
    const sessionCommands: readonly Command[] = sessions.slice(0, 20).map((session) => ({
      id: `session:${session.id}`,
      section: '会话',
      title: session.title.length > 0 ? session.title : '未命名会话',
      icon: MessageSquare,
      action: () => {
        setActiveSession(session.id);
        navigate(ROUTES.chatPath(session.id));
        closePalette();
      },
    }));

    return [...baseCommands, ...fileCommands, ...sessionCommands];
  }, [
    resolvedTheme,
    setTheme,
    clearActiveSession,
    setActiveSession,
    enterWelcomeMode,
    navigate,
    onOpenChange,
    sessionsData?.sessions,
    rootPath,
    getAllFilePaths,
    openFile,
  ]);

  // 过滤命令（标题模糊匹配）
  const filtered = useMemo(() => {
    if (query.trim().length === 0) return commands;
    const q = query.toLowerCase();
    return commands.filter((cmd) => cmd.title.toLowerCase().includes(q));
  }, [commands, query]);

  // activeIndex 边界修正（过滤后列表变短时重置）
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(0);
    }
  }, [filtered.length, activeIndex]);

  // 执行命令
  const execute = useCallback((cmd: Command | undefined) => {
    if (cmd === undefined) return;
    cmd.action();
  }, []);

  // 键盘导航：↑↓ + Enter + Esc
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execute(filtered[activeIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    },
    [filtered, activeIndex, execute, onOpenChange],
  );

  if (!open) return null;

  return (
    <>
      <div
        className="palette-overlay show"
        role="dialog"
        aria-label="命令面板"
        aria-modal="true"
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          // 点击遮罩空白处关闭
          if (e.target === e.currentTarget) onOpenChange(false);
        }}
      >
        <div className="palette">
          <div className="palette-input-wrap">
            <Search className="size-4" strokeWidth={2} />
            <input
              ref={inputRef}
              type="text"
              className="palette-input"
              placeholder="搜索文件或输入命令…"
              aria-label="命令面板搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="palette-results">
            {filtered.length === 0 ? (
              <div className="palette-empty">无匹配结果</div>
            ) : (
              filtered.map((cmd, index) => {
                const Icon = cmd.icon;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    className={cn('palette-item', index === activeIndex && 'active')}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => execute(cmd)}
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
                  </button>
                );
              })
            )}
          </div>
          <div className="palette-foot">
            <span>
              <kbd>↑↓</kbd> 导航
            </span>
            <span>
              <kbd>⏎</kbd> 选择
            </span>
            <span>
              <kbd>esc</kbd> 关闭
            </span>
          </div>
        </div>
      </div>
      {settingsOpen && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
    </>
  );
}
