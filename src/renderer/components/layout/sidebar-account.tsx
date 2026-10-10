import { Check, ExternalLink, Languages, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
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
import { openExternal } from '@/lib/app-actions';
import { LANGUAGE_ENDONYMS } from '@/lib/language-endonyms';
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
    openExternal(ISSUES_URL).catch(() => {});
  };

  return (
    <div className="sidebar-foot">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 focus:outline-none"
            aria-label={t('sidebar.accountMenu')}
          >
            <span className="avatar" aria-hidden="true">
              <User className="size-3.5" strokeWidth={1.5} />
            </span>
            <span className="user-info">
              <span className="uname">{t('sidebar.notLoggedIn')}</span>
              <span className="uemail">local-user</span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-48">
          <DropdownMenuLabel>{t('sidebar.accountMenu')}</DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => openSettings()}>
            <Settings className="size-3.5" />
            {t('topbar.settings')}
          </DropdownMenuItem>

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
                  {LANGUAGE_ENDONYMS[code]}
                  {currentLang === code && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

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

          <DropdownMenuItem onSelect={handleReportIssue}>
            <ExternalLink className="size-3.5" />
            {t('sidebar.reportIssue')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
