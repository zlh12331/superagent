// src/renderer/components/settings/sections/placeholders.tsx
// 设置导航 · 移动端 pane 组合（远程控制 + IM 渠道两块真实能力）
// ──────────────────────────────────────────────────────────────
// - 纯规划的 pane（账号/插件/hooks/命令）已移除导航入口（2026-08-22 决策：
//   未实现功能不暴露入口），后续落地时随实现一并恢复
// - 移动端 pane 原为「🚧 规划中」占位，阶段 2.5 远程控制落地后改为真实面板
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { ImChannelsSection } from './im-channels-section';
import { RemoteControlSection } from './remote-control-section';

/** 移动端：局域网远程控制配对 + IM 渠道配置 */
export function MobileSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 pt-2">
      <RemoteControlSection />
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.imChannels')}</h3>
        <div className="mt-2">
          <ImChannelsSection />
        </div>
      </div>
    </div>
  );
}
