// src/renderer/components/settings/sections/placeholders.tsx
// 轻量 pane 集合（对齐 Trae Work 设置导航结构；无对应后端的功能诚实占位）
// ──────────────────────────────────────────────────────────────
// 包含：账号 / 移动端 / 插件 / hooks / 命令
// - 占位 pane 明确标注"规划中/不可用"，不伪造假功能（实事求是原则）
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { ImChannelsSection } from './im-channels-section';

/** 通用占位布局：图标 + 标题 + 规划说明 */
function PlaceholderPane({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): ReactElement {
  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">{description}</p>
      <div className="border-border bg-muted/20 rounded-md border px-3 py-2.5">
        <span className="text-muted-foreground text-2xs">🚧 {title} · 规划中</span>
      </div>
    </div>
  );
}

/** 账号（无登录后端：诚实占位） */
export function AccountSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <PlaceholderPane title={t('settings.nav.account')} description={t('settings.accountHint')} />
  );
}

/** 移动端（纯桌面应用：不可用标注；IM 渠道真实功能保留于此） */
export function MobileSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 pt-2">
      <PlaceholderPane title={t('settings.nav.mobile')} description={t('settings.mobileHint')} />
      {/* IM 渠道（真实功能：企微/飞书桥接配置） */}
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.imChannels')}</h3>
        <div className="mt-2">
          <ImChannelsSection />
        </div>
      </div>
    </div>
  );
}

/** 插件（无插件系统：规划占位） */
export function PluginsSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <PlaceholderPane title={t('settings.nav.plugins')} description={t('settings.pluginsHint')} />
  );
}

/** hooks（无 hooks 系统：规划占位） */
export function HooksSection(): ReactElement {
  const { t } = useTranslation();
  return <PlaceholderPane title={t('settings.nav.hooks')} description={t('settings.hooksHint')} />;
}

/** 命令（命令面板操作命令只读列表——静态展示，配置化规划中） */
export function CommandsSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <PlaceholderPane title={t('settings.nav.commands')} description={t('settings.commandsHint')} />
  );
}
