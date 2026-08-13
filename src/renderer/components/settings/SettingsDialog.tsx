// src/renderer/components/settings/SettingsDialog.tsx
// 设置全屏页 · 组装层
// ──────────────────────────────────────────────────────────────
// 设计（用户要求全屏形态，对齐桌面 LLM 客户端设置页）：
// - Sheet 全屏覆盖（无抽屉调宽，右上角关闭按钮避让窗口控件）
// - 左侧分组导航（tablist 语义 + 方向键循环）
// - 右侧内容区按 activeSection 分发渲染（renderSection 集中分发）
// - 现有 sections/ 面板保持独立（拆分成果保留），本文件仅编排
// ──────────────────────────────────────────────────────────────

import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  BarChart3,
  BookOpenText,
  FlaskConical,
  FolderTree,
  Globe,
  Info,
  Plug,
  Puzzle,
  Server as ServerIcon,
  Settings as SettingsIcon,
  Smartphone,
  Sparkles,
  TerminalSquare,
  User,
  Workflow,
} from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { SectionErrorBoundary } from '@/components/common/SectionErrorBoundary';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { AboutSection } from './sections/about-section';
import { BrowserSection } from './sections/browser-section';
import { ExperimentalSection } from './sections/experimental-section';
import { GeneralSection } from './sections/general-section';
import { McpSection } from './sections/mcp-section';
import { ModelsSection } from './sections/models-section';
import {
  AccountSection,
  CommandsSection,
  HooksSection,
  MobileSection,
  PluginsSection,
} from './sections/placeholders';
import { RulesMemorySection } from './sections/rules-memory-section';
import { SkillsSection } from './sections/skills-section';
import { UsageSection } from './sections/usage-section';
import { WorkspaceSection } from './sections/workspace-section';

/** SettingsDialog props */
export interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 开关回调 */
  readonly onOpenChange: (open: boolean) => void;
}

/** 设置分区 ID */
type SectionId =
  | 'account'
  | 'usage'
  | 'general'
  | 'mobile'
  | 'browser'
  | 'workspace'
  | 'commands'
  | 'rules-memory'
  | 'models'
  | 'mcp'
  | 'skills'
  | 'hooks'
  | 'plugins'
  | 'beta'
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
    labelKey: 'settings.group.accountGeneral',
    items: [
      { id: 'account', labelKey: 'settings.nav.account', icon: User },
      { id: 'usage', labelKey: 'settings.nav.usage', icon: BarChart3 },
      { id: 'general', labelKey: 'settings.nav.general', icon: SettingsIcon },
      { id: 'mobile', labelKey: 'settings.nav.mobile', icon: Smartphone },
    ],
  },
  {
    labelKey: 'settings.group.capabilities',
    items: [
      // 模型服务：提供商/API Key/运行时模型统一管理（对齐同类桌面 LLM 客户端）
      { id: 'models', labelKey: 'settings.nav.models', icon: ServerIcon },
      { id: 'mcp', labelKey: 'settings.nav.mcp', icon: Plug },
      { id: 'skills', labelKey: 'settings.nav.skills', icon: Sparkles },
      { id: 'plugins', labelKey: 'settings.nav.plugins', icon: Puzzle },
      { id: 'hooks', labelKey: 'settings.nav.hooks', icon: Workflow },
      { id: 'browser', labelKey: 'settings.nav.browser', icon: Globe },
      { id: 'workspace', labelKey: 'settings.nav.workspace', icon: FolderTree },
    ],
  },
  {
    labelKey: 'settings.group.agent',
    items: [
      { id: 'commands', labelKey: 'settings.nav.commands', icon: TerminalSquare },
      { id: 'rules-memory', labelKey: 'settings.nav.rulesMemory', icon: BookOpenText },
    ],
  },
  {
    labelKey: 'settings.group.beta',
    items: [{ id: 'beta', labelKey: 'settings.nav.beta', icon: FlaskConical }],
  },
  {
    labelKey: 'settings.group.about',
    items: [{ id: 'about', labelKey: 'settings.nav.about', icon: Info }],
  },
];

/** 抽屉宽度范围（对齐参考项目：360-800，默认 540） */

/**
 * 分区渲染器（集中分发，避免 JSX 堆叠 11 个条件分支）
 */
function renderSection(section: SectionId, drawerOpen: boolean): ReactElement {
  switch (section) {
    case 'account':
      return <AccountSection />;
    case 'usage':
      return <UsageSection />;
    case 'general':
      return <GeneralSection drawerOpen={drawerOpen} />;
    case 'mobile':
      return <MobileSection />;
    case 'browser':
      return <BrowserSection />;
    case 'workspace':
      return <WorkspaceSection />;
    case 'commands':
      return <CommandsSection />;
    case 'rules-memory':
      return <RulesMemorySection />;
    case 'models':
      return <ModelsSection />;
    case 'mcp':
      return <McpSection />;
    case 'skills':
      return <SkillsSection />;
    case 'hooks':
      return <HooksSection />;
    case 'plugins':
      return <PluginsSection />;
    case 'beta':
      return <ExperimentalSection />;
    case 'about':
      return <AboutSection />;
  }
}

/**
 * 设置全屏页（组装层）
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): ReactElement {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SectionId>('models');

  // 打开时重置到默认分区（避免上次停留的深层分区）
  useEffect(() => {
    if (open) {
      setActiveSection('models');
    }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-card flex h-full w-full max-w-none flex-col gap-0 border-l p-0">
        <SheetTitle className="sr-only">{t('settings.title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('settings.desc')}</SheetDescription>

        {/* 头部（左上角返回按钮；右侧预留窗口控件 overlay 区 140px 透明拖拽） */}
        <div className="bg-muted/50 flex shrink-0 items-center gap-2.5 border-b px-[18px] py-3.5">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm transition-colors"
            aria-label={t('settings.back')}
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
            {t('settings.back')}
          </button>
          <SettingsIcon className="text-primary size-4" strokeWidth={1.5} />
          <span className="text-foreground text-sm font-semibold">{t('settings.title')}</span>
          <span className="text-muted-foreground font-mono text-xs">{t('settings.desc')}</span>
          {/* 窗口控件 overlay 预留区（透明拖拽：不遮挡系统关闭/最小化按钮） */}
          <div className="app-region-drag ml-auto h-full w-[140px] shrink-0" aria-hidden="true" />
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
            {/* 组件级错误边界：pane 抛错局部降级（不拖垮整个设置抽屉）；
               resetKeys 随分区切换重置错误态——此前切分区后错误残留 */}
            <SectionErrorBoundary name={`settings:${activeSection}`} resetKeys={[activeSection]}>
              {renderSection(activeSection, open)}
            </SectionErrorBoundary>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
