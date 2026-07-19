// src/renderer/routes/settings.tsx
// 应用设置路由
// 设计文档 §3 路由结构 + §7.7 应用设置
//
// 职责：
// - 顶部标题「应用设置」
// - 依次渲染四个 Section（每个 Section 内部已用 Card 包裹）：
//   1. ApiKeySection：DeepSeek API Key 设置
//   2. OllamaConfigSection：Ollama 配置只读展示
//   3. ProjectSettingsLink：项目选择器
//   4. AiParamsSection：当前项目的 AI 模型参数表单
// - 通过 selectedProjectId state 把 ProjectSettingsLink 与 AiParamsSection 串联
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { ReactElement } from 'react';
import { useState } from 'react';

import { AiParamsSection } from '@/components/settings/AiParamsSection';
import { ApiKeySection } from '@/components/settings/ApiKeySection';
import { OllamaConfigSection } from '@/components/settings/OllamaConfigSection';
import { ProjectSettingsLink } from '@/components/settings/ProjectSettingsLink';

/**
 * 应用设置页面
 *
 * 组合 4 个 Section：API Key / Ollama / 项目选择 / AI 参数。
 * ProjectSettingsLink 选中的 projectId 通过 useState 传递给 AiParamsSection。
 */
export function Component(): ReactElement {
  // 当前选中的项目 ID（null 表示未选择，AiParamsSection 会提示用户先选项目）
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl p-6">
      {/* 顶部标题 */}
      <h1 className="text-foreground mb-4 text-lg font-semibold">应用设置</h1>
      {/* 四个 Section 垂直排列：每个 Section 内部已用 Card 包裹 */}
      <div className="flex flex-col gap-4">
        <ApiKeySection />
        <OllamaConfigSection />
        <ProjectSettingsLink
          selectedProjectId={selectedProjectId}
          onProjectChange={setSelectedProjectId}
        />
        <AiParamsSection projectId={selectedProjectId} />
      </div>
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'SettingsPage';
