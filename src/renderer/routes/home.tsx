import type { ApiKeyProvider, ErrorCode } from '@code-agent/shared/renderer';
import { ChevronDown, Folder, LayoutGrid, Plus, Search, Star, Wrench } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { ChatInput } from '@/components/chat/ChatInput';
import { BrandMark } from '@/components/common/BrandMark';
import { ModelSelector } from '@/components/common/ModelSelector';
import { MotionReveal } from '@/components/common/MotionReveal';
import { useCreateSession, useRecentDirs } from '@/hooks/use-sessions';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { pickDirectory } from '@/lib/dialog-actions';
import { formatRelativeTime } from '@/lib/format-time';
import { unwrapErrorMessage } from '@/lib/ipc';
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

/** 欢迎页路由：品牌区 + composer（首条消息 stash 透传 ChatPanel）+ 快捷动作 + 最近项目 */
export function HomePage(): ReactElement {
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

  const [inputValue, setInputValue] = useState('');

  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const folderGroupRef = useRef<HTMLDivElement>(null);

  const dirs = recentDirsData?.dirs ?? [];

  const currentFolderLabel = pendingWorkingDir ? basename(pendingWorkingDir) : t('home.noProject');

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次（enterWelcomeMode 为 zustand 稳定引用）
  useEffect(() => {
    enterWelcomeMode(null);
  }, []);

  useEffect(() => {
    if (pendingWorkingDir !== null) return;
    const firstDir = dirs[0]?.workingDir;
    if (firstDir === undefined) return;
    setPendingWorkingDir(firstDir);
  }, [pendingWorkingDir, dirs, setPendingWorkingDir]);

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
      const data = await pickDirectory();
      if (data.canceled || data.path === undefined) {
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
    if (pendingWorkingDir === null || pendingWorkingDir === '') {
      toast.message(t('home.chooseProject'), {
        description: t('home.chooseProjectDesc'),
      });
      setFolderMenuOpen(true);
      return;
    }

    try {
      const { sessionId } = await createSession({ workingDir: pendingWorkingDir });
      setActiveSession(sessionId);
      if (text.trim().length > 0) {
        stashPendingMessage(sessionId, text);
      }
      exitWelcomeMode();
      navigate(ROUTES.chatPath(sessionId));
    } catch {}
  };

  /** 快捷 pill 点击：预填输入框（不自动发送，对齐原型行为） */
  const handleQuickAction = (prompt: string): void => {
    setInputValue(prompt);
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    input?.focus();
  };

  const chatStatus: 'submitted' | 'ready' = isCreating ? 'submitted' : 'ready';

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
    <>
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
            <BrandMark size={40} />
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
  const updateAi = useSettingsStore((state) => state.updateAi);
  return (
    <>
      <ChatInput
        status={chatStatus}
        onSend={onSend}
        onStop={() => {}}
        value={inputValue}
        onValueChange={onValueChange}
        disabled={isCreating}
        placeholder={t('chat.inputPlaceholder')}
      />

      <div className="composer-project-bar">
        <div className="cpb-folder-group" ref={folderGroupRef}>
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

          {folderMenuOpen && (
            <div className="folder-dropdown-menu show" role="menu" aria-label={t('home.dirList')}>
              <div className="fdm-scroll">
                {folderItems.length === 0 ? (
                  <div className="fdm-empty">{t('home.noRecentDirs')}</div>
                ) : (
                  <>
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
