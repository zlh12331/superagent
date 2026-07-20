// src/renderer/components/settings/OllamaConfigSection.tsx
// Ollama 配置只读展示区块 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 卡片标题用 font-serif 衬线字体
// - 状态色用文学风 token：success（墨绿）/ warning（琥珀）/ muted（灰墨）/ error（朱红）
// - 模型名/百分比用 font-mono 等宽字体
// - 进度条用 bg-primary 文学风深棕色
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 从 useAppStatusStore 读取 Ollama 服务状态、模型就绪标志与拉取进度
// - 用中文 + 状态色展示服务状态（运行中→success，启动中→warning，停止→muted，未安装→error）
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

/** 状态信息：label 中文文案 + color 文学风 Tailwind 颜色类 */
interface StatusInfo {
  label: string;
  color: string;
}

/**
 * 获取 Ollama 服务状态的中文标签与展示色（文学风 token）
 *
 * 使用 switch-case 而非对象字面量，避免 Biome useNamingConvention
 * 对 snake_case / UPPER_CASE key 报错。
 *
 * 文学风配色：
 * - running：success（墨绿）
 * - starting：warning（琥珀）
 * - stopped：muted-foreground（灰墨）
 * - not_installed：error（朱红）
 */
function getOllamaStatusLabel(status: OllamaStatus): StatusInfo {
  switch (status) {
    case 'running':
      return { label: '运行中', color: 'text-success' };
    case 'starting':
      return { label: '启动中', color: 'text-warning' };
    case 'stopped':
      return { label: '已停止', color: 'text-muted-foreground' };
    case 'not_installed':
      return { label: '未安装', color: 'text-error' };
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
        {/* 标题用衬线字体 */}
        <CardTitle className="flex items-center gap-2 font-serif tracking-wide">
          <Cpu className="size-4" strokeWidth={1.5} />
          Ollama 配置
        </CardTitle>
        <CardDescription>本地嵌入向量生成服务，由主进程统一管理</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* 服务状态行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground font-serif text-sm">服务状态</span>
          <span className={`font-serif text-sm font-medium tracking-wide ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        {/* 嵌入模型名称行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground font-serif text-sm">嵌入模型</span>
          <span className="font-mono text-sm tracking-wide">{EMBEDDING_MODEL_NAME}</span>
        </div>
        {/* 模型就绪状态行 */}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground font-serif text-sm">模型就绪</span>
          <span
            className={`font-serif text-sm font-medium tracking-wide ${
              ollamaModelReady ? 'text-success' : 'text-error'
            }`}
          >
            {ollamaModelReady ? '是 ✓' : '否 ✗'}
          </span>
        </div>
        {/* 拉取进度条：仅在 pullProgress 非 null 时展示 */}
        {pullProgress !== null && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-serif">
                正在拉取模型：{pullProgress.model}
              </span>
              <span className="text-muted-foreground font-mono tracking-wide">{pullPercent}%</span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width] duration-300"
                style={{ width: `${pullPercent}%` }}
              />
            </div>
          </div>
        )}
        <p className="text-muted-foreground font-serif text-xs leading-relaxed">
          Ollama 用于本地嵌入向量生成，安装请参考官方文档
        </p>
      </CardContent>
    </Card>
  );
}
