// src/renderer/routes/settings.tsx
// 设置路由占位
// 设计文档 §3 路由结构 + §7.7 应用设置
//
// 职责：
// - 展示应用设置表单（占位）
// - 后续 Phase 8 将接入 settings.service（API Key / 模型 / Ollama 配置）

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** 应用设置页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>应用设置</CardTitle>
          <CardDescription>Phase 8 实现：API Key / 模型 / Ollama 配置</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示设置表单，包括：
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>DeepSeek API Key（加密存入 keychain）</li>
            <li>Ollama 嵌入模型选择与下载</li>
            <li>PostgreSQL 嵌入版本切换</li>
            <li>AI 生成参数（temperature / max_tokens）</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'SettingsPage';
