// src/renderer/routes/home.tsx
// 应用首页 · 欢迎页模式（对齐原型 .view-chat.welcome-mode）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 welcome-view（品牌大字）+ composer（输入框 + project-bar）+ welcome-quick-actions（快捷 pill）
// - composer-project-bar：folder dropdown 选择历史目录 / 浏览其他目录
// - 发送消息时：若 pendingWorkingDir 为空 → toast 提示并展开 dropdown（不弹原生对话框）
//                                 不为空 → createSession + 跳转 /chat/:id
// - 快捷 pill 点击：预填输入框（不自动发送，用户可编辑后回车）
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - 原型 setWelcomeMode(true) 后展示 welcome-view + composer + project-bar + quick-actions
// - 原型 setWelcomeMode(false) 在选中会话 / 发送消息创建会话后触发
// - 原型 folder dropdown 通过 folderDropdownMenu 渲染：本地 / 历史 folders / 选择文件夹…
// - 本组件仅负责渲染内容，welcome-mode class 由 AppShell 根据 useWelcomeStore 切换
// ──────────────────────────────────────────────────────────────

import { ChevronDown, Folder, LayoutGrid, Plus, Search, Star, Wrench } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { ChatInput } from '@/components/chat/ChatInput';
import { ModelSelector } from '@/components/common/ModelSelector';
import { useCreateSession, useRecentDirs } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/format-time';
import { pendingMessageKey } from '@/lib/pending-message';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

/** 快捷动作定义（对齐原型 4 个 welcome-pill） */
interface QuickAction {
  readonly key: string;
  /** i18n key（label 与 prompt 均由组件内 t() 渲染，避免模块级常量碰 hook） */
  readonly labelKey: string;
  readonly promptKey: string;
  readonly icon: typeof LayoutGrid;
}

/** 快捷动作列表（对齐原型 data-welcome-action） */
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'app-dev', labelKey: 'home.appDev', promptKey: 'home.appDevPrompt', icon: LayoutGrid },
  {
    key: 'project-understand',
    labelKey: 'home.projectUnderstanding',
    promptKey: 'home.projectUnderstandingPrompt',
    icon: Search,
  },
  { key: 'game-idea', labelKey: 'home.gameIdea', promptKey: 'home.gameIdeaPrompt', icon: Star },
  {
    key: 'tool-knowledge',
    labelKey: 'home.toolKnowledge',
    promptKey: 'home.toolKnowledgePrompt',
    icon: Wrench,
  },
] as const;

/** 路径 basename（跨平台，取最后一段） */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function HomePage(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { mutateAsync: createSession, isPending: isCreating } = useCreateSession();
  const { data: recentDirsData } = useRecentDirs();
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const pendingWorkingDir = useWelcomeStore((state) => state.pendingWorkingDir);
  const exitWelcomeMode = useWelcomeStore((state) => state.exitWelcomeMode);
  const setPendingWorkingDir = useWelcomeStore((state) => state.setPendingWorkingDir);

  const defaultProvider = useSettingsStore((state) => state.ai.defaultProvider);
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);
  const updateAi = useSettingsStore((state) => state.updateAi);

  // 受控输入值（支持快捷 pill 预填）
  const [inputValue, setInputValue] = useState('');

  // folder dropdown 开关
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const folderGroupRef = useRef<HTMLDivElement>(null);

  // 历史目录列表（去重后由主进程返回）
  const dirs = recentDirsData?.dirs ?? [];

  // 派生：当前显示的 folder 名（pendingWorkingDir 的 basename，或「未选择项目」）
  const currentFolderLabel = pendingWorkingDir ? basename(pendingWorkingDir) : t('home.noProject');

  // 兜底初始化 pendingWorkingDir（对齐原型 prototype-v2.html:13312-13315）
  // 场景：首次启动 / 通过 URL 直接访问 /home / 进入欢迎页时无激活会话
  // 行为：若 pendingWorkingDir 为 null 且有历史目录，自动取第一个（最近的）
  // 注意：仅在 pendingWorkingDir 为 null 时填充，不覆盖用户已主动选择的目录
  useEffect(() => {
    if (pendingWorkingDir !== null) return;
    const firstDir = dirs[0]?.workingDir;
    if (firstDir === undefined) return;
    setPendingWorkingDir(firstDir);
  }, [pendingWorkingDir, dirs, setPendingWorkingDir]);

  // 点击外部关闭 folder dropdown
  useEffect(() => {
    if (!folderMenuOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (
        folderGroupRef.current !== null &&
        !folderGroupRef.current.contains(event.target as Node)
      ) {
        setFolderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [folderMenuOpen]);

  // ESC 关闭 folder dropdown
  useEffect(() => {
    if (!folderMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setFolderMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [folderMenuOpen]);

  /**
   * 选择历史目录：设置 pendingWorkingDir + 关闭 dropdown
   *
   * 对齐原型 switchToFolder(folder)：仅更新 pendingFolder，不切换 welcome-mode。
   */
  const handleSelectFolder = (workingDir: string | null): void => {
    setPendingWorkingDir(workingDir);
    setFolderMenuOpen(false);
  };

  /**
   * 浏览其他目录：触发原生目录选择器
   *
   * 对齐原型 fdm-action-btn「选择文件夹…」点击逻辑。
   * 用户取消选择：保持 dropdown 打开，允许重新选择。
   */
  const handleBrowseFolder = async (): Promise<void> => {
    try {
      const response = await window.api.dialog.pickDirectory({});
      if ('error' in response) {
        toast.error(`[${response.error.code}] ${response.error.message}`);
        return;
      }
      if (response.data.canceled || response.data.path === undefined) {
        // 用户取消：保持 dropdown 打开
        return;
      }
      setPendingWorkingDir(response.data.path);
      setFolderMenuOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * 创建会话并跳转聊天页
   *
   * 流程：
   * 1. 校验 pendingWorkingDir：为空 → toast 提示 + 自动展开 dropdown（不弹原生对话框）
   * 2. 调用 createSession IPC 创建会话
   * 3. setActiveSession + navigate 到 /chat/:id
   * 4. exitWelcomeMode（ChatPage 进入时也会再次确保退出）
   *
   * 错误处理：
   * - IPC 失败：useCreateSession 的 onError 已 toast 提示
   */
  const handleSend = async (text: string): Promise<void> => {
    // 步骤 1：校验 workingDir（对齐原型：不允许「本地」模式创建无目录会话）
    if (pendingWorkingDir === null || pendingWorkingDir === '') {
      toast.message(t('home.chooseProject'), {
        description: t('home.chooseProjectDesc'),
      });
      setFolderMenuOpen(true);
      return;
    }

    // 步骤 2：创建会话
    try {
      const { sessionId } = await createSession({ workingDir: pendingWorkingDir });
      // 步骤 3：设置激活 + 跳转
      setActiveSession(sessionId);
      // 退出欢迎页模式（与 navigate 同一 React commit，避免视觉闪烁）
      exitWelcomeMode();
      navigate(ROUTES.chatPath(sessionId));
      // 透传首条消息：通过 sessionStorage 暂存，ChatPanel 挂载后读取并发送
      // （避免在 navigate 前直接调用 sendMessage，因为 ChatPanel 还未挂载；
      //   key 契约见 lib/pending-message.ts，消费方为 ChatPanel）
      if (text.trim().length > 0) {
        // createdAt 供消费方做陈旧性防护（Electron 持久化 sessionStorage，
        // 跨应用重启残留的暂存消息不能自动发送）
        sessionStorage.setItem(
          pendingMessageKey(sessionId),
          JSON.stringify({ text, createdAt: Date.now() }),
        );
      }
    } catch {
      // onError 已在 useCreateSession 中 toast 提示
      // 保持欢迎页打开，允许重试
    }
  };

  /** 快捷 pill 点击：预填输入框（不自动发送，对齐原型行为） */
  const handleQuickAction = (prompt: string): void => {
    setInputValue(prompt);
    // 聚焦输入框（用户可能想立即编辑）
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    input?.focus();
  };

  // ChatInput status：创建中视为 submitted（显示禁用 + loading 态）
  const chatStatus: 'submitted' | 'ready' = isCreating ? 'submitted' : 'ready';

  // 派生：是否禁用发送（创建中禁用，避免重复提交）
  const isDisabled = isCreating;

  // 派生：quick action 按钮列表（React Compiler 自动缓存，无需手写 useMemo）
  const quickActionButtons = QUICK_ACTIONS.map((action) => {
    const Icon = action.icon;
    return (
      <button
        key={action.key}
        type="button"
        className="welcome-pill"
        onClick={() => handleQuickAction(t(action.promptKey))}
        disabled={isCreating}
      >
        <Icon strokeWidth={2} />
        {t(action.labelKey)}
      </button>
    );
  });

  // 派生：folder dropdown 项列表（React Compiler 自动缓存）
  const folderItems = dirs.map((dir) => {
    const name = basename(dir.workingDir);
    const isActive = pendingWorkingDir === dir.workingDir;
    return (
      <button
        key={dir.workingDir}
        type="button"
        className={cn('fdm-item', isActive && 'active')}
        onClick={() => handleSelectFolder(dir.workingDir)}
        title={dir.workingDir}
      >
        <span className="fdm-icon">
          <Folder size={13} strokeWidth={2} />
        </span>
        <span className="fdm-name">{name}</span>
        <span className="fdm-meta">{formatRelativeTime(dir.lastUsed, t, true)}</span>
      </button>
    );
  });

  return (
    // 欢迎页容器：空 div 即可，CSS .view-chat.welcome-mode 会重排 .thread-bg 为居中 flex
    // 内部四层结构对齐原型：welcome-view + composer(含 project-bar) + quick-actions
    <>
      {/* 品牌区：welcome-view（默认隐藏，welcome-mode 下显示） */}
      <div className="welcome-view">
        <div className="welcome-logo">
          <span className="wl-icon">⟨/⟩</span>
          <span>Code with TRAE</span>
        </div>
      </div>

      {/* 输入区：.composer 外壳 + ChatInput（.composer-box 内层）+ composer-project-bar
          对齐原型：composer 在 welcome-mode 下透明背景 + 最大宽度 720px */}
      <footer className="composer">
        <ChatInput
          status={chatStatus}
          onSend={handleSend}
          onStop={() => {
            // 欢迎页无流式生成，stop 仅用于满足 ChatInput 接口
          }}
          value={inputValue}
          onValueChange={setInputValue}
          disabled={isDisabled}
          placeholder={t('chat.inputPlaceholder')}
        />

        {/* composer-project-bar：folder dropdown + 模型选择器占位
            对齐原型：仅在 welcome-mode 下显示（基础样式 display:none） */}
        <div className="composer-project-bar">
          <div className="cpb-folder-group" ref={folderGroupRef}>
            {/* 当前 folder 显示 + 展开按钮 */}
            <button
              type="button"
              className="cpb-select"
              aria-expanded={folderMenuOpen}
              aria-haspopup="menu"
              aria-label={t('home.chooseProjectLabel')}
              onClick={() => setFolderMenuOpen((prev) => !prev)}
            >
              <Folder size={12} strokeWidth={2} />
              <span>{currentFolderLabel}</span>
              <ChevronDown className="cpb-caret" size={10} strokeWidth={2} />
            </button>

            {/* folder dropdown menu */}
            {folderMenuOpen && (
              <div className="folder-dropdown-menu show" role="menu" aria-label={t('home.dirList')}>
                <div className="fdm-scroll">
                  {dirs.length === 0 ? (
                    <div className="fdm-empty">{t('home.noRecentDirs')}</div>
                  ) : (
                    <>
                      {/* 清空选择（回到「未选择项目」） */}
                      <button
                        type="button"
                        className={cn('fdm-item', pendingWorkingDir === null && 'active')}
                        onClick={() => handleSelectFolder(null)}
                      >
                        <span className="fdm-icon">
                          <Folder size={13} strokeWidth={2} />
                        </span>
                        <span className="fdm-name">{t('home.noProject')}</span>
                      </button>
                      {dirs.length > 0 && <div className="fdm-sep" />}
                      {folderItems}
                    </>
                  )}
                </div>
                {/* 浏览其他目录：触发原生目录选择器 */}
                <button
                  type="button"
                  className="fdm-action-btn"
                  onClick={() => {
                    void handleBrowseFolder();
                  }}
                >
                  <span className="fdm-icon">
                    <Plus size={13} strokeWidth={2} />
                  </span>
                  <span>{t('home.chooseFolder')}</span>
                </button>
              </div>
            )}
          </div>

          <ModelSelector
            provider={defaultProvider}
            model={defaultModel}
            onProviderChange={(p) => updateAi({ defaultProvider: p })}
            onModelChange={(m) => updateAi({ defaultModel: m })}
            disabled={isCreating}
          />
        </div>
      </footer>

      {/* 快捷动作区：welcome-quick-actions（默认隐藏，welcome-mode 下显示） */}
      <div className="welcome-quick-actions">{quickActionButtons}</div>
    </>
  );
}

export default HomePage;
export const Component = HomePage;
