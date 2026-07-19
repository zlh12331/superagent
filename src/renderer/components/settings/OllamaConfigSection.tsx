// src/renderer/components/settings/OllamaConfigSection.tsx
// Ollama 配置只读展示区块
// 设计文档 §7.7 应用设置 + §7.9 Ollama 嵌入服务健康监控
//
// 职责：
// - 从 useAppStatusStore 读取 Ollama 服务状态、模型就绪标志与拉取进度
// - 用中文 + 状态色展示服务状态（运行中→绿，启动中→黄，停止→灰，未安装→红）
// - 当 pullProgress 非 null 时展示模型拉取进度条
//
// 注意：
// - 本区块为只读展示，不提供任何启停操作（Ollama 启停由主进程统一管理）
// - 嵌入模型名称暂时硬编码，后续可改为从 config 动态读取

import type { AppStatus } from '@novel-writer/shared';
import { Cpu } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAppStatusStore } from '@/stores/app-status.store';

/** Ollama 状态字面量类型，与 AppStatus['ollamaStatus'] 对齐 */
type OllamaStatus = AppStatus['ollamaStatus'];

/** 嵌入模型名称（硬编码，后续从 config 读取时再改为动态） */
const EMBEDDING_MODEL_NAME = 'nemotron-3-embed-1b-bf16';

/**
 * 获取 Ollama 服务状态的中文标签与展示色
 *
 * 使用 switch-case 而非对象字面量，避免 Biome useNamingConvention
 * 对 snake_case / UPPER_CASE key 报错。
 */
function getOllamaStatusLabel(status: OllamaStatus): {
  label: string;
  color: string;
} {
  switch (status) {
    case 'running':
      return { label: '运行中', color: 'text-emerald-600' };
    case 'starting':
      return { label: '启动中', color: 'text-amber-600' };
    case 'stopped':
      return { label: '已停止', color: 'text-muted-foreground' };
    case 'not_installed':
      return { label: '未安装', color: 'text-rose-600' };
  }
}

/**
 * Ollama 配置只读展示区块
 *
 * @example
 * <OllamaConfigSection />
 */
export function OllamaConfigSection(): ReactElement {
  // 直接从 zustand store 读取所需字段，组件会自动响应状态变化
  const ollamaStatus = useAppStatusStore((s) => s.ollamaStatus);
  const ollamaModelReady = useAppStatusStore((s) => s.ollamaModelReady);
  const pullProgress = useAppStatusStore((s) => s.pullProgress);

  const statusInfo = getOllamaStatusLabel(ollamaStatus);
  // 拉取进度百分比：0~100，noUncheckedIndexedAccess 下也不会越界，这里仅做兜底
  const pullPercent = pullProgress?.percent ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-4" />
          Ollama 配置
        </CardTitle>
        <CardDescription>本地嵌入向量生成服务，由主进程统一管理</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* 服务状态行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">服务状态</span>
          <span className={`text-sm font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
        </div>
        {/* 嵌入模型名称行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">嵌入模型</span>
          <span className="font-mono text-sm">{EMBEDDING_MODEL_NAME}</span>
        </div>
        {/* 模型就绪状态行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">模型就绪</span>
          <span
            className={`text-sm font-medium ${
              ollamaModelReady ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {ollamaModelReady ? '是 ✓' : '否 ✗'}
          </span>
        </div>
        {/* 拉取进度条：仅在 pullProgress 非 null 时展示 */}
        {pullProgress !== null && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">正在拉取模型：{pullProgress.model}</span>
              <span className="text-muted-foreground">{pullPercent}%</span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width] duration-300"
                style={{ width: `${pullPercent}%` }}
              />
            </div>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          Ollama 用于本地嵌入向量生成，安装请参考官方文档
        </p>
      </CardContent>
    </Card>
  );
}
