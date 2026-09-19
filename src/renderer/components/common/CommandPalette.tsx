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
import {
  FileText,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Power,
  Search,
  Settings,
  Sun,
  TerminalSquare,
} from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { useSessionsQuery } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { useTheme } from '@/providers/ThemeProvider';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { nextTheme, type Theme } from '@/stores/persistent/settings-store';
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
 * 主题三态循环的展示元数据（表驱动）
 *
 * 「下一个主题」→ 文案/图标 此前写成一串嵌套三元（`nextTheme(theme) === 'light' ? … :
 * nextTheme(theme) === 'dark' ? … : …`），同一表达式重复求值 4 次、且是
 * CommandPalette 认知复杂度 33 的主要来源（2026-09 审计）。
 * 改为映射表后「下一主题 → 展示」成为数据，也是唯一真源。
 */
const THEME_META: Record<Theme, { readonly titleKey: string; readonly icon: typeof Sun }> = {
  light: { titleKey: 'palette.toggleThemeLight', icon: Sun },
  dark: { titleKey: 'palette.toggleThemeDark', icon: Moon },
  system: { titleKey: 'palette.toggleThemeSystem', icon: Monitor },
};

/**
 * 相对路径派生的两种分隔符处理
 *
 * 分离为纯函数（也是 Windows 反斜杠 / POSIX 正斜杠两个分支的唯一所在）：
 * 提取后 buildCommands 的分支数下降，本函数可独立推理。
 */
function toRelativePath(filePath: string, rootPath: string): string {
  const withSlash = `${rootPath}/`;
  const withBackslash = `${rootPath}\\`;
  if (filePath.startsWith(withSlash) || filePath.startsWith(withBackslash)) {
    return filePath.slice(rootPath.length + 1);
  }
  return filePath;
}

/** 构建命令列表所需的运行时依赖（全部由组件从 hooks 取出后注入） */
interface BuildCommandsContext {
  readonly t: ReturnType<typeof useTranslation>['t'];
  readonly modKey: string;
  readonly theme: Theme;
  readonly setTheme: (theme: Theme) => void;
  readonly sidebarView: 'threads' | 'fileTree';
  readonly setSidebarView: (view: 'threads' | 'fileTree') => void;
  readonly sidebarCollapsed: boolean;
  readonly setSidebarCollapsed: (collapsed: boolean) => void;
  readonly rightPanelCollapsed: boolean;
  readonly setRightPanelCollapsed: (collapsed: boolean) => void;
  readonly rootPath: string | null;
  readonly getAllFilePaths: () => readonly string[];
  readonly openFile: (path: string) => void;
  readonly sessions: readonly { readonly id: string; readonly title: string }[];
  readonly setActiveSession: (id: string) => void;
  readonly navigate: (to: string) => void;
  readonly clearActiveSession: () => void;
  readonly enterWelcomeMode: (dir: string | null) => void;
  readonly openSettings: () => void;
  /** 退出应用（minimize 模式下的兜底退出入口，见 28-tray-spec §3） */
  readonly quitApp: () => void;
  readonly closePalette: () => void;
}

/**
 * 构建命令面板的完整命令列表（操作组 + 文件组 + 会话组）
 *
 * 抽离动机（2026-09 审计）：此前是内联在组件里的 130 行 IIFE，含 10+ 处条件分支
 * （侧栏视图/折叠态三元、路径前缀双分支、分页平铺、空标题兜底、上限切片），
 * 使 CommandPalette 认知复杂度达 33（阈值 15）。移出组件后各分支集中在纯函数里，
 * 组件只剩「取状态 → 调用 → 渲染」。
 */
function buildCommands(ctx: BuildCommandsContext): readonly CommandItemData[] {
  const { t, closePalette } = ctx;
  const isFileTree = ctx.sidebarView === 'fileTree';
  // 「下一个主题」的展示元数据。
  // 先取到局部变量再传给 t：check-i18n 的「间接引用」识别只匹配
  // t(标识符 / 成员访问)，写成 t(THEME_META[x].titleKey)（含方括号）不会被识别，
  // 会把三个主题 key 误报为「冗余」。
  const themeMeta = THEME_META[nextTheme(ctx.theme)];

  const baseCommands: readonly CommandItemData[] = [
    {
      id: 'new-chat',
      section: t('palette.sectionActions'),
      title: t('palette.newChat'),
      icon: Plus,
      // 与 settings 默认快捷键一致，按平台显示修饰键（此前硬编码 Ctrl+N）
      shortcut: `${ctx.modKey}+N`,
      action: () => {
        ctx.clearActiveSession();
        ctx.enterWelcomeMode(null);
        ctx.navigate(ROUTES.home);
        closePalette();
      },
    },
    {
      id: 'toggle-theme',
      section: t('palette.sectionActions'),
      // 三态循环（dark→light→system）：标题与图标指向「下一个」主题（表驱动）
      title: t(themeMeta.titleKey),
      icon: themeMeta.icon,
      action: () => {
        ctx.setTheme(nextTheme(ctx.theme));
        closePalette();
      },
    },
    {
      id: 'open-settings',
      section: t('palette.sectionActions'),
      title: t('palette.openSettings'),
      icon: Settings,
      action: () => {
        ctx.openSettings();
        closePalette();
      },
    },
    {
      id: 'quit-app',
      section: t('palette.sectionActions'),
      title: t('palette.quitApp'),
      icon: Power,
      action: () => {
        ctx.quitApp();
        closePalette();
      },
    },
    {
      id: 'toggle-sidebar-view',
      section: t('palette.sectionActions'),
      title: isFileTree ? t('palette.backToSessions') : t('palette.openFileTree'),
      icon: isFileTree ? MessagesSquare : FolderOpen,
      action: () => {
        ctx.setSidebarView(isFileTree ? 'threads' : 'fileTree');
        closePalette();
      },
    },
    {
      // 对齐参考项目 show/hide-left-sidebar 命令（标题随折叠状态切换，快捷键 ⌘B/⌘1 另有绑定）
      id: 'toggle-sidebar',
      section: t('palette.sectionActions'),
      title: ctx.sidebarCollapsed ? t('palette.showSidebar') : t('palette.hideSidebar'),
      icon: PanelLeft,
      action: () => {
        ctx.setSidebarCollapsed(!ctx.sidebarCollapsed);
        closePalette();
      },
    },
    {
      // 对齐参考项目 show/hide-right-sidebar 命令（标题随折叠状态切换，快捷键 ⌘J/⌘2 另有绑定）
      id: 'toggle-right-panel',
      section: t('palette.sectionActions'),
      title: ctx.rightPanelCollapsed ? t('palette.showRightPanel') : t('palette.hideRightPanel'),
      icon: PanelRight,
      action: () => {
        ctx.setRightPanelCollapsed(!ctx.rightPanelCollapsed);
        closePalette();
      },
    },
    {
      // 对齐参考项目 codex.openTerminal 命令（Ctrl+` 快捷键另有绑定）
      id: 'open-terminal',
      section: t('palette.sectionActions'),
      title: t('palette.openTerminal'),
      icon: TerminalSquare,
      action: () => {
        // 展开右面板 + 切换到终端 tab
        useUiStore.getState().setRightPanelCollapsed(false);
        useUiStore.getState().setDevPanelTab('terminal');
        closePalette();
      },
    },
  ];

  return [...baseCommands, ...buildFileCommands(ctx), ...buildSessionCommands(ctx)];
}

/** 文件打开命令：从文件树派生（最多 50 条避免列表过长） */
function buildFileCommands(ctx: BuildCommandsContext): readonly CommandItemData[] {
  if (ctx.rootPath === null) return [];
  return ctx
    .getAllFilePaths()
    .slice(0, 50)
    .map((filePath) => ({
      id: `file:${filePath}`,
      section: ctx.t('palette.sectionFiles'),
      title: toRelativePath(filePath, ctx.rootPath ?? ''),
      icon: FileText,
      action: () => {
        ctx.openFile(filePath);
        ctx.closePalette();
      },
    }));
}

/** 会话切换命令：从会话列表派生（最多 20 条避免列表过长） */
function buildSessionCommands(ctx: BuildCommandsContext): readonly CommandItemData[] {
  return ctx.sessions.slice(0, 20).map((session) => ({
    id: `session:${session.id}`,
    section: ctx.t('palette.sectionSessions'),
    title: session.title.length > 0 ? session.title : ctx.t('palette.unnamedSession'),
    icon: MessageSquare,
    action: () => {
      ctx.setActiveSession(session.id);
      ctx.navigate(ROUTES.chatPath(session.id));
      ctx.closePalette();
    },
  }));
}

/**
 * 命令面板组件（cmdk + fuse.js）
 *
 * 受控模式：由父组件（AppShell）管理 open 状态 + ⌘P 快捷键。
 * cmdk 负责键盘导航与选中态；fuse.js 负责命令模糊搜索。
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): ReactElement | null {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  // 本地化文案
  const { t } = useTranslation();
  // 平台修饰键：macOS ⌘ / Windows-Linux Ctrl（快捷键展示与 settings 默认一致）
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac') === true;
  const modKey = isMac ? '⌘' : 'Ctrl';
  const clearActiveSession = useActiveSessionStore((state) => state.clearActiveSession);
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  const { data: sessionsData } = useSessionsQuery();

  const rootPath = useFileTreeStore((state) => state.rootPath);
  const getAllFilePaths = useFileTreeStore((state) => state.getAllFilePaths);
  const openFile = useFileViewerStore((state) => state.openFile);

  const [query, setQuery] = useState('');
  // 关闭时清空搜索词：本组件由 AppShell 常驻挂载（关闭只 `return null`，状态保留），
  // 此前重新打开会带着上一次的搜索词与 cmdk 内部选中态。放在关闭分支里清，
  // 而不是打开时清——避免打开首帧先渲染旧词再被重置的闪烁。
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  // 全局 UI store：设置对话框入口（命令面板 / Topbar / 错误动作共享）
  const openSettings = useUiStore((state) => state.openSettings);
  // 侧栏视图切换（文件树为独立视图：对齐参考项目 codex.openFileTree 命令）
  const sidebarView = useUiStore((state) => state.sidebarView);
  const setSidebarView = useUiStore((state) => state.setSidebarView);
  // 面板折叠切换（对齐参考项目 show/hide-left/right-sidebar 命令：标题随状态切换）
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const rightPanelCollapsed = useUiStore((state) => state.rightPanelCollapsed);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const setRightPanelCollapsed = useUiStore((state) => state.setRightPanelCollapsed);

  // 命令列表（操作组 + 文件组 + 会话组）（依赖外部状态派生；React Compiler 自动缓存）
  // 构建逻辑已外提为 buildCommands（见文件头「抽离动机」），组件只负责注入依赖
  const sessions = sessionsData?.pages.flatMap((page) => page.sessions) ?? [];
  const commands = buildCommands({
    t,
    modKey,
    theme,
    setTheme,
    sidebarView,
    setSidebarView,
    sidebarCollapsed,
    setSidebarCollapsed,
    rightPanelCollapsed,
    setRightPanelCollapsed,
    rootPath,
    getAllFilePaths,
    openFile,
    sessions,
    setActiveSession,
    navigate: (to) => {
      navigate(to);
    },
    clearActiveSession,
    enterWelcomeMode: (dir) => {
      enterWelcomeMode(dir);
    },
    openSettings,
    quitApp: () => {
      // 退出走完整善后链（before-quit 协商 → dispose → 延迟安装）
      void window.api?.app.quit();
    },
    closePalette: () => onOpenChange(false),
  });

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
        // 键盘可达性：Esc 关闭。cmdk 1.1.1 自身**不**处理 Escape（其 root
        // onKeyDown 只覆盖 n/j/p/k/Arrow/Enter/Home/End，也不持有 onOpenChange），
        // 故此处的显式处理是唯一路径，不是兜底重复。
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
