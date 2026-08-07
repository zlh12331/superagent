// src/renderer/components/settings/SettingsDialog.tsx
// 设置抽屉 · 组装层（对齐原型 .drawer + 参考项目 superagent PreferencesDialog）
// ──────────────────────────────────────────────────────────────
// 设计（对齐参考项目 superagent 的 PreferencesDialog）：
// - Sheet 右侧滑出抽屉（默认 540px，360-800px 可拖拽调宽，键盘方向键步进）
// - 左侧 160px 分组导航（4 组 11 个 pane，tablist 语义 + 方向键循环）
// - 右侧内容区按 activeSection 分发渲染（renderSection 集中分发）
// - 现有 sections/ 10 个面板保持独立（拆分成果保留），本文件仅编排
//
// 导航分组（业务语义映射）：
// - 模型与权限：API 密钥 / 模型参数 / 运行时模型 / 审批模式
// - 视图与外观：系统提示词 / 快捷键
// - 账户与数据：用量 / 回合 / IM 渠道 / 数据
// - 高级：遥测
// ──────────────────────────────────────────────────────────────

import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  BarChart3,
  Database,
  FlaskConical,
  Info,
  Keyboard,
  KeyRound,
  MessageSquareText,
  MessageSquareWarning,
  PenLine,
  Radio,
  ScrollText,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Shield,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { SectionErrorBoundary } from '@/components/common/SectionErrorBoundary';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { AboutSection } from './sections/about-section';
import { ApiKeySection } from './sections/api-key-section';
import { ApprovalModeSection } from './sections/approval-mode-section';
import { DataSection } from './sections/data-section';
import { EditorSection } from './sections/editor-section';
import { ExperimentalSection } from './sections/experimental-section';
import { ImChannelsSection } from './sections/im-channels-section';
import { McpSection } from './sections/mcp-section';
import { ModelParamsSection } from './sections/model-params-section';
import { PromptSection } from './sections/prompt-section';
import { RuntimeModelsSection } from './sections/runtime-models-section';
import { ShortcutsSection } from './sections/shortcuts-section';
import { SkillsSection } from './sections/skills-section';
import { TelemetrySection } from './sections/telemetry-section';
import { TurnsSection } from './sections/turns-section';
import { UsageSection } from './sections/usage-section';

/** SettingsDialog props */
export interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 开关回调 */
  readonly onOpenChange: (open: boolean) => void;
}

/** 设置分区 ID */
type SectionId =
  | 'api-key'
  | 'model-params'
  | 'runtime-models'
  | 'approval-mode'
  | 'mcp'
  | 'prompt'
  | 'shortcuts'
  | 'skills'
  | 'editor'
  | 'experimental'
  | 'usage'
  | 'turns'
  | 'im-channels'
  | 'data'
  | 'telemetry'
  | 'about';

/** 导航项 */
interface NavItem {
  readonly id: SectionId;
  readonly labelKey: string;
  readonly icon: LucideIcon;
}

/** 导航分组 */
interface NavGroup {
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

/** 导航分组（4 组，语义归组） */
const NAV_GROUPS: readonly NavGroup[] = [
  {
    labelKey: 'settings.group.modelPerms',
    items: [
      { id: 'api-key', labelKey: 'settings.nav.apiKey', icon: KeyRound },
      { id: 'model-params', labelKey: 'settings.nav.modelParams', icon: SlidersHorizontal },
      { id: 'runtime-models', labelKey: 'settings.nav.runtimeModels', icon: Radio },
      { id: 'approval-mode', labelKey: 'settings.nav.approvalMode', icon: Shield },
    ],
  },
  {
    labelKey: 'settings.group.viewPrompt',
    items: [
      { id: 'editor', labelKey: 'settings.nav.editor', icon: PenLine },
      { id: 'experimental', labelKey: 'settings.nav.experimental', icon: FlaskConical },
      { id: 'shortcuts', labelKey: 'settings.nav.shortcuts', icon: Keyboard },
      { id: 'prompt', labelKey: 'settings.nav.prompt', icon: MessageSquareText },
    ],
  },
  {
    labelKey: 'settings.group.accountData',
    items: [
      { id: 'skills', labelKey: 'settings.nav.skills', icon: Sparkles },
      { id: 'usage', labelKey: 'settings.nav.usage', icon: BarChart3 },
      { id: 'turns', labelKey: 'settings.nav.turns', icon: ScrollText },
      { id: 'im-channels', labelKey: 'settings.nav.imChannels', icon: MessageSquareWarning },
      { id: 'data', labelKey: 'settings.nav.data', icon: Database },
    ],
  },
  {
    labelKey: 'settings.group.advanced',
    items: [
      { id: 'mcp', labelKey: 'settings.nav.mcp', icon: ServerIcon },
      { id: 'telemetry', labelKey: 'settings.nav.telemetry', icon: AlertTriangle },
      { id: 'about', labelKey: 'settings.nav.about', icon: Info },
    ],
  },
];

/** 抽屉宽度范围（对齐参考项目：360-800，默认 540） */
const DRAWER_MIN_WIDTH = 360;
const DRAWER_DEFAULT_WIDTH = 540;
/** 抽屉宽度 localStorage key（用户拖宽后跨会话保留） */
const DRAWER_WIDTH_STORAGE_KEY = 'code-agent:settings-drawer-width';

/** 读取持久化宽度（无记录 / 非法值回退默认） */
function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= DRAWER_MIN_WIDTH) {
      return stored;
    }
  } catch {
    // localStorage 不可用（隐私模式等）：回退默认
  }
  return DRAWER_DEFAULT_WIDTH;
}

/**
 * 分区渲染器（集中分发，避免 JSX 堆叠 11 个条件分支）
 */
function renderSection(section: SectionId, drawerOpen: boolean): ReactElement {
  switch (section) {
    case 'api-key':
      return (
        <>
          <ApiKeySection provider="deepseek" label="DeepSeek" />
          <div className="mt-2 border-t" />
          <div className="mt-2">
            <ApiKeySection provider="openai" label="OpenAI" />
          </div>
        </>
      );
    case 'model-params':
      return <ModelParamsSection />;
    case 'mcp':
      return <McpSection />;
    case 'runtime-models':
      return <RuntimeModelsSection />;
    case 'approval-mode':
      return <ApprovalModeSection />;
    case 'prompt':
      return <PromptSection open={drawerOpen} />;
    case 'shortcuts':
      return <ShortcutsSection />;
    case 'skills':
      return <SkillsSection />;
    case 'editor':
      return <EditorSection />;
    case 'experimental':
      return <ExperimentalSection />;
    case 'usage':
      return <UsageSection />;
    case 'turns':
      return <TurnsSection />;
    case 'im-channels':
      return <ImChannelsSection />;
    case 'data':
      return <DataSection />;
    case 'telemetry':
      return <TelemetrySection />;
    case 'about':
      return <AboutSection />;
  }
}

/**
 * 抽屉拖拽调宽（Pointer Events + RAF 节流，对齐参考项目 useDrawerResize）
 */
function useDrawerResize() {
  const [width, setWidth] = useState(readStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef({ startX: 0, startWidth: DRAWER_DEFAULT_WIDTH, maxW: 0 });
  const sheetRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number | null>(null);

  // 宽度持久化：拖拽/键盘调整后写入 localStorage（关闭重开保留用户偏好）
  useEffect(() => {
    try {
      localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // localStorage 不可用（隐私模式等）：忽略
    }
  }, [width]);

  // 拖拽时禁用文本选中
  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const maxW = Math.round(window.innerWidth * 0.92);
      dragState.current = { startX: e.clientX, startWidth: width, maxW };
      setIsDragging(true);

      const handlePointerMove = (ev: PointerEvent): void => {
        const delta = dragState.current.startX - ev.clientX;
        const newWidth = Math.min(
          dragState.current.maxW,
          Math.max(DRAWER_MIN_WIDTH, dragState.current.startWidth + delta),
        );
        // 直接操作 DOM 即时反馈，RAF 合并 React 状态更新（性能优化）
        const sheet = sheetRef.current;
        if (sheet !== null) sheet.style.width = `${newWidth}px`;
        pendingWidthRef.current = newWidth;
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            if (pendingWidthRef.current !== null) {
              setWidth(pendingWidthRef.current);
              pendingWidthRef.current = null;
            }
          });
        }
      };

      const handlePointerEnd = (): void => {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        if (pendingWidthRef.current !== null) {
          setWidth(pendingWidthRef.current);
          pendingWidthRef.current = null;
        }
        setIsDragging(false);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerEnd);
        document.removeEventListener('pointercancel', handlePointerEnd);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerEnd);
      document.addEventListener('pointercancel', handlePointerEnd);
    },
    [width],
  );

  return { width, isDragging, handlePointerDown, sheetRef, setWidth };
}

/**
 * 设置抽屉（组装层）
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SectionId>('api-key');
  const { width, isDragging, handlePointerDown, sheetRef, setWidth } = useDrawerResize();

  // 打开时重置到默认分区（避免上次停留的深层分区）
  useEffect(() => {
    if (open) {
      setActiveSection('api-key');
    }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={sheetRef}
        style={{ width: `${width}px` }}
        className="bg-card flex max-w-[92vw] flex-col gap-0 border-l p-0"
      >
        <SheetTitle className="sr-only">{t('settings.title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('settings.desc')}</SheetDescription>

        {/* 拖拽调宽条（抽屉左边缘，对齐原型 .drawer-resizer）
            hr 为语义分隔线（自带 separator role），拖拽把手效果用自身样式实现 */}
        <hr
          aria-label={t('settings.drawerResizer')}
          aria-valuenow={width}
          aria-valuemin={DRAWER_MIN_WIDTH}
          aria-valuemax={Math.round(window.innerWidth * 0.92)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              setWidth((w) => Math.min(Math.round(window.innerWidth * 0.92), w + 20));
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              setWidth((w) => Math.max(DRAWER_MIN_WIDTH, w - 20));
            }
          }}
          title={t('settings.drawerResizer')}
          className={cn(
            // h-full 必须显式：Tailwind preflight 给 hr 默认 height:0，
            // 与 inset-y-0 的 top/bottom 拉伸冲突（height 优先 → 手柄高度 0 不可拖）
            'absolute inset-y-0 left-[-4px] z-[5] m-0 h-full w-[8px] touch-none cursor-col-resize border-none transition-colors',
            isDragging ? 'bg-primary/15' : 'hover:bg-primary/10 bg-transparent',
          )}
        />

        {/* 头部 */}
        <div className="bg-muted/50 flex shrink-0 items-center gap-2.5 border-b px-[18px] py-3.5">
          <SettingsIcon className="text-primary size-4" strokeWidth={1.5} />
          <span className="text-foreground text-sm font-semibold">{t('settings.title')}</span>
          <span className="text-muted-foreground font-mono text-xs">{t('settings.desc')}</span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors"
            aria-label={t('common.close')}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 主体：左导航 + 右内容 */}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[160px_1fr] overflow-hidden">
          {/* 导航 */}
          <div
            className="bg-muted/30 overflow-y-auto overflow-x-hidden border-r px-2 py-3"
            role="tablist"
            aria-label={t('settings.sectionsAriaLabel')}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const buttons = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-nav-item="true"]'),
              );
              if (buttons.length === 0) return;
              const activeEl = document.activeElement as HTMLElement | null;
              // biome-ignore lint/complexity/useIndexOf: activeEl 为 HTMLElement，indexOf 需断言，findIndex 类型安全
              const currentIndex = buttons.findIndex((btn) => btn === activeEl);
              const nextIndex =
                e.key === 'ArrowDown'
                  ? currentIndex === -1 || currentIndex === buttons.length - 1
                    ? 0
                    : currentIndex + 1
                  : currentIndex <= 0
                    ? buttons.length - 1
                    : currentIndex - 1;
              buttons[nextIndex]?.focus();
            }}
          >
            {NAV_GROUPS.map((group) => (
              <div key={group.labelKey} className="mb-1">
                <div className="text-muted-foreground px-3 pt-2 pb-1 text-2xs font-semibold tracking-[0.08em] uppercase">
                  {t(group.labelKey)}
                </div>
                {group.items.map((item) => {
                  const isActive = activeSection === item.id;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-nav-item="true"
                      onClick={() => setActiveSection(item.id)}
                      className={cn(
                        'text-muted-foreground hover:bg-muted hover:text-foreground mb-0.5 flex w-full items-center gap-[9px] rounded-[7px] border-l-2 border-l-transparent px-2.5 py-2 text-left text-sm transition-colors',
                        // 激活态：accent 竖条（对齐原型 L3535 inset 2px）+ 文字用 foreground
                        // （text-primary 青色在浅色模式白底上仅 2.51:1，不满足 WCAG AA）
                        isActive &&
                          'bg-card text-foreground border-l-[color:var(--accent)] font-medium',
                      )}
                    >
                      <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
                      <span className="truncate">{t(item.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 内容区 */}
          <div className="overflow-y-auto overflow-x-hidden px-5 py-[18px]">
            {/* 组件级错误边界：pane 抛错局部降级（不拖垮整个设置抽屉） */}
            <SectionErrorBoundary name={`settings:${activeSection}`}>
              {renderSection(activeSection, open)}
            </SectionErrorBoundary>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
