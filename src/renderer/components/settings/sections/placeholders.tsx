// src/renderer/components/settings/sections/placeholders.tsx
// 设置导航 · 移动端 pane 组合（远程控制 + IM 渠道两块真实能力）
// ──────────────────────────────────────────────────────────────
// - 纯规划的 pane（账号/插件/hooks/命令）已移除导航入口（2026-08-22 决策：
//   未实现功能不暴露入口），后续落地时随实现一并恢复
// - 移动端 pane 原为「🚧 规划中」占位，阶段 2.5 远程控制落地后改为真实面板
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { ImChannelsSection } from './im-channels-section';
import { RemoteControlSection } from './remote-control-section';

/** 移动端：局域网远程控制配对 + IM 渠道配置 */
export function MobileSection(): ReactElement {
  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* 两块子面板各自带标题（RemoteControlSection / ImChannelsSection 均渲染自身
          的分区头）。此前组合层额外套了一个 "IM 渠道" h3，与子面板标题**重复**，
          且与远程控制侧（裸渲染）不一致——已去除。 */}
      <RemoteControlSection />
      <ImChannelsSection />
    </div>
  );
}
