import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  BarChart3,
  BookOpenText,
  FlaskConical,
  FolderTree,
  Globe,
  Info,
  Keyboard,
  Network,
  Plug,
  Server as ServerIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { SectionErrorBoundary } from '@/components/common/SectionErrorBoundary';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { type SettingsSectionId, useUiStore } from '@/stores/transient/ui-store';
import { AboutSection } from './sections/about-section';
import { ApprovalModeSection } from './sections/approval-mode-section';
import { BrowserSection } from './sections/browser-section';
import { ExperimentalSection } from './sections/experimental-section';
import { GeneralSection } from './sections/general-section';
import { McpSection } from './sections/mcp-section';
import { ModelsSection } from './sections/models-section';
import { MobileSection } from './sections/placeholders';
import { ProxySection } from './sections/proxy-section';
import { RulesMemorySection } from './sections/rules-memory-section';
import { ShortcutsSection } from './sections/shortcuts-section';
import { SkillsSection } from './sections/skills-section';
import { TerminalSection } from './sections/terminal-section';
import { UsageSection } from './sections/usage-section';
import { WorkspaceSection } from './sections/workspace-section';

/** SettingsDialog props */
export interface SettingsDialogProps {
  /** 是否打开（受控） */
  readonly open: boolean;
  /** 开关回调 */
  readonly onOpenChange: (open: boolean) => void;
}

/** 默认分区（未指定直达分区时的落地页） */
const DEFAULT_SECTION: SettingsSectionId = 'models';

/** 导航项 */
interface NavItem {
  readonly id: SettingsSectionId;
  readonly labelKey: string;
  readonly icon: LucideIcon;
}

/** 导航分组 */
interface NavGroup {
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

/** 导航分组（5 组 15 项，语义归组；未实现的规划入口已移除，见 docs/design/05 §14） */
const NAV_GROUPS: readonly NavGroup[] = [
  {
    labelKey: 'settings.group.general',
    items: [
      { id: 'usage', labelKey: 'settings.nav.usage', icon: BarChart3 },
      { id: 'general', labelKey: 'settings.nav.general', icon: SettingsIcon },
      { id: 'proxy', labelKey: 'settings.nav.proxy', icon: Network },
      { id: 'mobile', labelKey: 'settings.nav.mobile', icon: Smartphone },
    ],
  },
  {
    labelKey: 'settings.group.capabilities',
    items: [
      { id: 'models', labelKey: 'settings.nav.models', icon: ServerIcon },
      { id: 'mcp', labelKey: 'settings.nav.mcp', icon: Plug },
      { id: 'skills', labelKey: 'settings.nav.skills', icon: Sparkles },
      { id: 'browser', labelKey: 'settings.nav.browser', icon: Globe },
      { id: 'workspace', labelKey: 'settings.nav.workspace', icon: FolderTree },
      { id: 'terminal', labelKey: 'settings.nav.terminal', icon: TerminalSquare },
      { id: 'shortcuts', labelKey: 'settings.nav.shortcuts', icon: Keyboard },
    ],
  },
  {
    labelKey: 'settings.group.agent',
    items: [
      { id: 'rules-memory', labelKey: 'settings.nav.rulesMemory', icon: BookOpenText },
      { id: 'approval-mode', labelKey: 'settings.nav.approvalMode', icon: ShieldCheck },
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
function renderSection(section: SettingsSectionId, drawerOpen: boolean): ReactElement {
  switch (section) {
    case 'usage':
      return <UsageSection />;
    case 'general':
      return <GeneralSection drawerOpen={drawerOpen} />;
    case 'proxy':
      return <ProxySection />;
    case 'mobile':
      return <MobileSection />;
    case 'browser':
      return <BrowserSection />;
    case 'workspace':
      return <WorkspaceSection />;
    case 'terminal':
      return <TerminalSection />;
    case 'shortcuts':
      return <ShortcutsSection />;
    case 'rules-memory':
      return <RulesMemorySection />;
    case 'models':
      return <ModelsSection />;
    case 'approval-mode':
      return <ApprovalModeSection />;
    case 'mcp':
      return <McpSection />;
    case 'skills':
      return <SkillsSection />;
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
  const activeSection = useUiStore((s) => s.settingsSection ?? DEFAULT_SECTION);
  const setActiveSection = useUiStore((s) => s.setSettingsSection);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-card flex h-full w-full max-w-none flex-col gap-0 border-l p-0">
        <SheetTitle className="sr-only">{t('settings.title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('settings.desc')}</SheetDescription>

        <div className="bg-muted/50 flex shrink-0 items-center gap-2.5 border-b px-[18px] py-3.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground h-9 gap-1.5 rounded-lg px-3 text-sm"
            aria-label={t('settings.back')}
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
            {t('settings.back')}
          </Button>
          <SettingsIcon className="text-primary size-4" strokeWidth={1.5} />
          <span className="text-foreground text-sm font-semibold">{t('settings.title')}</span>
          <span className="text-muted-foreground font-mono text-xs">{t('settings.desc')}</span>
          <div className="app-region-drag ml-auto h-full w-[140px] shrink-0" aria-hidden="true" />
        </div>

        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[160px_1fr] overflow-hidden">
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
                        'text-muted-foreground hover:bg-muted hover:text-foreground mb-0.5 flex w-full items-center gap-[9px] rounded-[calc(var(--radius)-1px)] border-l-2 border-l-transparent px-2.5 py-2 text-left text-sm transition-colors',
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

          <div className="overflow-y-auto overflow-x-hidden px-5 py-[18px]">
            <SectionErrorBoundary name={`settings:${activeSection}`} resetKeys={[activeSection]}>
              {renderSection(activeSection, open)}
            </SectionErrorBoundary>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
