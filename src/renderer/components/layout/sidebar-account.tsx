// src/renderer/components/layout/sidebar-account.tsx
// 侧栏底部账户触发器 + 下拉菜单（对齐参考项目 SidebarAccountSection + 原型 .account-trigger）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 固定在侧栏底部的账户触发器（头像 + 名称），点击展开下拉
// - 下拉项（2026-09-04 重设计，共 4 项）：
//   - 设置：打开全屏设置（与 Topbar 共用 ui-store.openSettings）
//   - 语言 ▸：子菜单简体中文/English（changeLanguage 即时生效，持久化到 settings-store）
//   - 主题 ▸：子菜单亮色/暗色/跟随系统（settings-store 持久化）
//   - 报告问题：打开 GitHub issues 页（app.openExternal，真实仓库地址）
// - 本地模式（local-user）：无真实登录后端，仅展示本地标识
// ──────────────────────────────────────────────────────────────

import { Check, ExternalLink, Languages, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { changeLanguage, SUPPORTED_LANGUAGES } from '@/i18n/config';
import { useTranslation } from '@/i18n/use-translation';
import { useTheme } from '@/providers/ThemeProvider';
import { type AppLanguage, useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

/** 报告问题落地页（superagent 仓库 issues；私有仓库对外 404 属正常，真实地址由仓库 owner 提供） */
const ISSUES_URL = 'https://github.com/zlh12331/superagent/issues';

/**
 * 侧栏账户区（触发器 + 下拉菜单）
 */
export function SidebarAccount(): ReactElement {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  // 全局 UI store：设置对话框入口（与 Topbar 共享）
  const openSettings = useUiStore((state) => state.openSettings);

  /** 当前语言（i18n.language 可能为 'en-US' 等扩展码，归一为 'en'） */
  const currentLang = i18n.language?.startsWith('en') ? 'en' : ('zh-CN' as const);

  /** 切换语言：i18next 即时生效 + 写穿透 settings-store（与设置页 LanguageRow 同一持久化链路） */
  const handleSelectLanguage = (code: string): void => {
    changeLanguage(code as (typeof SUPPORTED_LANGUAGES)[number]);
    useSettingsStore.getState().setLanguage(code as AppLanguage);
  };

  /** 报告问题：打开 GitHub issues（仅 http/https，复用 app:openExternal 安全校验） */
  const handleReportIssue = (): void => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    void window.api.app.openExternal({ url: ISSUES_URL });
  };

  return (
    <div className="sidebar-foot">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus:outline-none"
            aria-label={t('sidebar.accountMenu')}
          >
            <span className="avatar" aria-hidden="true">
              <User className="size-3.5" strokeWidth={1.5} />
            </span>
            <span className="user-info">
              <span className="uname">{t('sidebar.notLoggedIn')}</span>
              <span className="uemail">local-user</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-48">
          <DropdownMenuLabel>{t('sidebar.accountMenu')}</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* 设置：打开全屏设置对话框 */}
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            {t('topbar.settings')}
          </DropdownMenuItem>

          {/* 语言 ▸：子菜单双语（本地化名，显式展示，不改语言） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="size-3.5" />
              {t('sidebar.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {SUPPORTED_LANGUAGES.map((code) => (
                <DropdownMenuItem
                  key={code}
                  onSelect={() => handleSelectLanguage(code)}
                  aria-label={code}
                >
                  {code === 'zh-CN' ? '简体中文' : 'English'}
                  {currentLang === code && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* 主题 ▸：子菜单三选一（当前项 check，选中即时生效） */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {theme === 'dark' ? (
                <Moon className="size-3.5" />
              ) : theme === 'light' ? (
                <Sun className="size-3.5" />
              ) : (
                <Monitor className="size-3.5" />
              )}
              {t('sidebar.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setTheme('light')}>
                <Sun className="size-3.5" />
                {t('sidebar.themeLight')}
                {theme === 'light' && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme('dark')}>
                <Moon className="size-3.5" />
                {t('sidebar.themeDark')}
                {theme === 'dark' && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme('system')}>
                <Monitor className="size-3.5" />
                {t('sidebar.themeSystem')}
                {theme === 'system' && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* 报告问题：跳转 GitHub issues（AppError 安全校验 http/https） */}
          <DropdownMenuItem onSelect={handleReportIssue}>
            <ExternalLink className="size-3.5" />
            {t('sidebar.reportIssue')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
