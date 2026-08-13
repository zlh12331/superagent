// src/renderer/components/layout/sidebar-account.tsx
// 侧栏底部账户触发器 + 下拉菜单（对齐参考项目 SidebarAccountSection + 原型 .account-trigger）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 固定在侧栏底部的账户触发器（头像 + 名称），点击展开下拉
// - 下拉项：设置 / 切换主题 / 关于（版本信息）
// - 本地模式（local-user）：无真实登录后端，退出登录不提供（诚实标注）
// ──────────────────────────────────────────────────────────────

import { Check, Info, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppInfo } from '@/hooks/use-app-info';
import { useTranslation } from '@/i18n/use-translation';
import { useTheme } from '@/providers/ThemeProvider';
import { useUiStore } from '@/stores/transient/ui-store';

/**
 * 侧栏账户区（触发器 + 下拉菜单）
 */
export function SidebarAccount(): ReactElement {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  // 应用版本（app:getInfo 单一真源；此前硬编码 v0.1.0 与 Topbar 双写）
  const appInfo = useAppInfo();
  const appVersion = appInfo?.version !== undefined ? `v${appInfo.version}` : 'dev';
  // 全局 UI store：设置对话框入口（与 Topbar 共享）
  const openSettings = useUiStore((state) => state.openSettings);

  /** 关于：toast 展示版本信息（轻量实现，后续可升级为对话框） */
  const handleAbout = (): void => {
    toast.info(`Code Agent Desktop ${appVersion}`);
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
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            {t('topbar.settings')}
          </DropdownMenuItem>
          {/* 主题三选一（此前仅两态切换，system 无 UI 入口） */}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleAbout}>
            <Info className="size-3.5" />
            {t('sidebar.about')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
