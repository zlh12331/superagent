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

import type { ApiKeyProvider, ErrorCode } from '@code-agent/shared/renderer';
import { ChevronDown, CodeXml, Folder, LayoutGrid, Plus, Search, Star, Wrench } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { ChatInput } from '@/components/chat/ChatInput';
import { ModelSelector } from '@/components/common/ModelSelector';
import { MotionReveal } from '@/components/common/MotionReveal';
import { useCreateSession, useRecentDirs } from '@/hooks/use-sessions';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/format-time';
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';
import { fadeInVariants, letterContainerVariants, letterUpVariants } from '@/lib/motion';
import { basename, cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { usePendingMessageStore } from '@/stores/transient/pending-message-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

/** 品牌文案（欢迎页逐字入场用；读屏以容器 aria-label 暴露，逐字 span 隐藏）
 *  对齐产品名 Code Agent Desktop（顶栏 / electron-builder productName / README），
 *  不使用第三方商标；保留 "Code with ___" 句式与顶栏呼应而非重复 */
const BRAND_TEXT = 'Code with Agent';

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

export function HomePage(): ReactElement {
  // 本地化文案 + 错误码解析（单一真源）
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const navigate = useNavigate();
  const { mutateAsync: createSession, isPending: isCreating } = useCreateSession();
  const { data: recentDirsData } = useRecentDirs();
  const setActiveSession = useActiveSessionStore((state) => state.setActiveSession);
  const stashPendingMessage = usePendingMessageStore((state) => state.stash);
  const pendingWorkingDir = useWelcomeStore((state) => state.pendingWorkingDir);
  const exitWelcomeMode = useWelcomeStore((state) => state.exitWelcomeMode);
  const setPendingWorkingDir = useWelcomeStore((state) => state.setPendingWorkingDir);
  const enterWelcomeMode = useWelcomeStore((state) => state.enterWelcomeMode);

  const defaultProvider = useSettingsStore((state) => state.ai.defaultProvider);
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);

  // 受控输入值（支持快捷 pill 预填）
  const [inputValue, setInputValue] = useState('');

  // folder dropdown 开关
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const folderGroupRef = useRef<HTMLDivElement>(null);

  // 历史目录列表（去重后由主进程返回）
  const dirs = recentDirsData?.dirs ?? [];

  // 派生：当前显示的 folder 名（pendingWorkingDir 的 basename，或「未选择项目」）
  const currentFolderLabel = pendingWorkingDir ? basename(pendingWorkingDir) : t('home.noProject');

  // 路由与欢迎页模式同步：/new 斜杠命令、返回按钮、删除激活会话等任意路径回首页
  // 都必须进入欢迎页模式。此前仅侧栏「新建会话」入口调用 enterWelcomeMode——
  // 其它入口回首页时品牌区与快捷动作整体隐藏（只剩输入框悬空）。
  // enterWelcomeMode(null) 清空 pending 目录，由下方兜底逻辑从历史目录回填。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次（enterWelcomeMode 为 zustand 稳定引用）
  useEffect(() => {
    enterWelcomeMode(null);
  }, []);

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
      const data = unwrap(await window.api.dialog.pickDirectory({}));
      if (data.canceled || data.path === undefined) {
        // 用户取消：保持 dropdown 打开
        return;
      }
      setPendingWorkingDir(data.path);
      setFolderMenuOpen(false);
    } catch (error) {
      reportLocalizedError(error, getErrorMessage);
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
      // 步骤 3：设置激活 + 暂存首条消息 + 跳转
      setActiveSession(sessionId);
      // 透传首条消息：暂存进 transient store，ChatPanel 挂载后 consume 一次并自动发送
      // （必须在 navigate 之前写入：内存 store 无跨进程落盘，跳转后本函数不再有机会执行；
      //   消费端与过期规则见 stores/transient/pending-message-store.ts）
      if (text.trim().length > 0) {
        stashPendingMessage(sessionId, text);
      }
      // 退出欢迎页模式（与 navigate 同一 React commit，避免视觉闪烁）
      exitWelcomeMode();
      navigate(ROUTES.chatPath(sessionId));
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

  // 派生：quick action 按钮列表（渲染期直接映射；仅 4 项且无 memo 边界，无需 useMemo）
  const quickActionButtons = QUICK_ACTIONS.map((action) => {
    const Icon = action.icon;
    return (
      <motion.button
        key={action.key}
        type="button"
        className="welcome-pill"
        variants={fadeInVariants}
        onClick={() => handleQuickAction(t(action.promptKey))}
        disabled={isCreating}
      >
        <Icon strokeWidth={2} />
        {t(action.labelKey)}
      </motion.button>
    );
  });

  // 派生：folder dropdown 项列表（渲染期映射，长度受最近目录数限制）
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
    // 动效（MotionVault 灵感，lib/motion 落地）：
    // - welcome-logo：品牌标记先入，然后字母逐字上浮+去模糊
    // - composer：品牌完成后滑入（delay 0.45）
    // - quick-actions：最后错落入场（delay 0.6，逐项 50ms）
    <>
      {/* 品牌区：welcome-view（默认隐藏，welcome-mode 下显示） */}
      <div className="welcome-view">
        <motion.div
          className="welcome-logo"
          role="heading"
          aria-level={1}
          aria-label={BRAND_TEXT}
          variants={letterContainerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span aria-hidden="true" variants={letterUpVariants} className="wl-icon">
            {/* 品牌渐变定义：图标是 SVG，原文本字形的 background-clip 渐变不适用，
                改用 SVG linearGradient 供 stroke 引用（保持 accent→accent-2 的品牌观感）。
                该 svg 是纯资源容器（宽高 0、不渲染内容），故以 presentation 角色 + aria-hidden
                标记，避免被读屏当作无标题图形（a11y/noSvgWithoutTitle）。 */}
            <svg
              width="0"
              height="0"
              className="absolute"
              role="presentation"
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <linearGradient id="wl-brand-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent-2)" />
                </linearGradient>
              </defs>
            </svg>
            <CodeXml className="size-8" strokeWidth={1.5} stroke="url(#wl-brand-gradient)" />
          </motion.span>
          {BRAND_TEXT.split('').map((ch, index) => (
            <motion.span
              // biome-ignore lint/suspicious/noArrayIndexKey: 品牌文案逐字静态拆分，字符位置稳定
              key={index}
              aria-hidden="true"
              variants={letterUpVariants}
              style={{ display: 'inline-block', whiteSpace: 'pre' }}
            >
              {ch === ' ' ? '\u00A0' : ch}
            </motion.span>
          ))}
        </motion.div>
      </div>

      {/* 输入区：.composer 外壳 + ChatInput（.composer-box 内层）+ composer-project-bar
          对齐原型：composer 在 welcome-mode 下透明背景 + 最大宽度 720px */}
      <MotionReveal variant="slideUp" delay={0.45} className="composer">
        <FooterContent
          isCreating={isCreating}
          chatStatus={chatStatus}
          inputValue={inputValue}
          onValueChange={setInputValue}
          onSend={handleSend}
          folderMenuOpen={folderMenuOpen}
          setFolderMenuOpen={setFolderMenuOpen}
          folderGroupRef={folderGroupRef}
          currentFolderLabel={currentFolderLabel}
          pendingWorkingDir={pendingWorkingDir}
          handleBrowseFolder={handleBrowseFolder}
          handleSelectFolder={handleSelectFolder}
          folderItems={folderItems}
          defaultProvider={defaultProvider}
          defaultModel={defaultModel}
        />
      </MotionReveal>

      {/* 快捷动作区：welcome-quick-actions（默认隐藏，welcome-mode 下显示）
          错落入场：品牌(≈0.5s)与 composer(0.45s)之后起笔，逐项 50ms 淡入 */}
      <motion.div
        className="welcome-quick-actions"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.05, delayChildren: 0.65 } },
        }}
        initial="hidden"
        animate="visible"
      >
        {quickActionButtons}
      </motion.div>
    </>
  );
}

/** composer 内容（与欢迎页入场动画解耦：动画包装只需最外层，避免每次渲染重计算） */
interface FooterContentProps {
  readonly isCreating: boolean;
  readonly chatStatus: 'submitted' | 'ready';
  readonly inputValue: string;
  readonly onValueChange: (value: string) => void;
  readonly onSend: (text: string) => Promise<void>;
  readonly folderMenuOpen: boolean;
  /** zustand setter 原样传入（支持函数式更新） */
  readonly setFolderMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  readonly folderGroupRef: React.RefObject<HTMLDivElement | null>;
  readonly currentFolderLabel: string;
  readonly pendingWorkingDir: string | null;
  readonly handleBrowseFolder: () => Promise<void>;
  readonly handleSelectFolder: (workingDir: string | null) => void;
  readonly folderItems: ReactElement[];
  readonly defaultProvider: ApiKeyProvider;
  readonly defaultModel: string;
}

function FooterContent({
  isCreating,
  chatStatus,
  inputValue,
  onValueChange,
  onSend,
  folderMenuOpen,
  setFolderMenuOpen,
  folderGroupRef,
  currentFolderLabel,
  pendingWorkingDir,
  handleBrowseFolder,
  handleSelectFolder,
  folderItems,
  defaultProvider,
  defaultModel,
}: FooterContentProps): ReactElement {
  const { t } = useTranslation();
  // 模型选择器设置项直接来自全局 store（避免逐层透传 updateAi 类型擦除）
  const updateAi = useSettingsStore((state) => state.updateAi);
  return (
    <>
      <ChatInput
        status={chatStatus}
        onSend={onSend}
        onStop={() => {
          // 欢迎页无流式生成，stop 仅用于满足 ChatInput 接口
        }}
        value={inputValue}
        onValueChange={onValueChange}
        disabled={isCreating}
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
                {folderItems.length === 0 ? (
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
                    {folderItems.length > 0 && <div className="fdm-sep" />}
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
    </>
  );
}

/**
 * 统一错误提示：错误码 → i18n 文案（单一真源 lib/ipc），非 Error 直接字符串化
 *
 * 2026-09-06 审计修复：此前首页直接弹 error.message，[CODE] 前缀不会被本地化。
 */
function reportLocalizedError(error: unknown, getErrorMessage: (code: ErrorCode) => string): void {
  toast.error(error instanceof Error ? unwrapErrorMessage(error, getErrorMessage) : String(error));
}
