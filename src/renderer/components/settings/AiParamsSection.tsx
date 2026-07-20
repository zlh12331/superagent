// src/renderer/components/settings/AiParamsSection.tsx
// AI 模型参数区块（项目级） · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 卡片标题用 font-serif 衬线字体
// - 标签用 font-serif 衬线字体 + 字间距
// - 数字参数（temperature/max_tokens/topK/threshold）用 font-mono 等宽字体
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 当 projectId 为 null 时提示用户先选择项目
// - 当 projectId 有效时通过 useProjectSettings 加载该项目设置
// - 提供表单编辑 aiModel / aiTemperature / aiMaxTokens / rag* 等字段
// - 字段变化仅更新本地 useState，点击「保存」才提交到后端
//
// 注意：
// - 表单初始值从 query data 同步（useEffect 监听 data 变化）
// - ragEnabled=false 时禁用 ragTopK / ragThreshold 输入框
// - 因没有 shadcn Checkbox 组件，使用原生 <input type="checkbox">
// - 所有 hooks 顶层调用（Rules of Hooks），projectId=null 时通过 query enabled=false 短路

import { Bot } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useProjectSettings, useUpdateProjectSettings } from '@/hooks/use-settings';
import { handleIpcError } from '@/lib/handle-ipc-error';

interface AiParamsSectionProps {
  /** 当前选择的项目 ID（null 时禁用本区块并提示用户先选择项目） */
  projectId: string | null;
}

/**
 * 渲染卡片头部（标题 + 图标 + 描述）共用片段
 *
 * 文学风：标题用 font-serif 衬线字体，图标 strokeWidth=1.5
 */
function renderCardHeader(): ReactElement {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 font-serif tracking-wide">
        <Bot className="size-4" strokeWidth={1.5} />
        AI 模型参数（项目级）
      </CardTitle>
      <CardDescription>调整此项目的 AI 生成参数与 RAG 检索配置</CardDescription>
    </CardHeader>
  );
}

/**
 * AI 模型参数区块（项目级）
 *
 * @example
 * <AiParamsSection projectId={selectedProjectId} />
 */
export function AiParamsSection({ projectId }: AiParamsSectionProps): ReactElement {
  // 始终在顶层调用 hooks（Rules of Hooks），projectId=null 时 query enabled=false 不会发请求
  const { data, isLoading, error, refetch } = useProjectSettings(projectId);
  const { mutateAsync, isPending } = useUpdateProjectSettings();

  // 表单本地状态：保存成功前只更新本地，不直接写后端
  const [aiModel, setAiModel] = useState('');
  const [aiTemperature, setAiTemperature] = useState('1.0');
  const [aiMaxTokens, setAiMaxTokens] = useState('4096');
  const [ragEnabled, setRagEnabled] = useState(false);
  const [ragTopK, setRagTopK] = useState('5');
  const [ragThreshold, setRagThreshold] = useState('0.7');

  // 当 query data 到达时同步到本地表单 state
  // 依赖 data 引用变化（React Query 在数据刷新时会返回新引用）
  useEffect(() => {
    if (data !== undefined) {
      setAiModel(data.aiModel);
      setAiTemperature(String(data.aiTemperature));
      setAiMaxTokens(String(data.aiMaxTokens));
      setRagEnabled(data.ragEnabled);
      setRagTopK(String(data.ragTopK));
      setRagThreshold(String(data.ragThreshold));
    }
  }, [data]);

  // projectId 为 null：提示用户先选择项目
  if (projectId === null) {
    return (
      <Card>
        {renderCardHeader()}
        <CardContent>
          <p className="text-muted-foreground font-serif text-sm">请先在上方选择项目</p>
        </CardContent>
      </Card>
    );
  }

  // 加载中：展示旋转占位
  if (isLoading) {
    return (
      <Card>
        {renderCardHeader()}
        <CardContent>
          <LoadingSpinner label="正在加载项目设置..." />
        </CardContent>
      </Card>
    );
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return (
      <Card>
        {renderCardHeader()}
        <CardContent>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  /**
   * 保存表单：将本地 state 提交到后端
   *
   * 失败的 toast 由 mutation onError 统一处理，这里 try/catch 兜底
   */
  const handleSave = async (): Promise<void> => {
    // 简单校验：aiModel 不能为空
    if (aiModel.trim().length === 0) {
      toast.error('AI 模型不能为空');
      return;
    }
    try {
      await mutateAsync({
        projectId,
        aiModel: aiModel.trim(),
        aiTemperature: Number(aiTemperature),
        aiMaxTokens: Number(aiMaxTokens),
        ragEnabled,
        ragTopK: Number(ragTopK),
        ragThreshold: Number(ragThreshold),
      });
      toast.success('设置已保存');
    } catch (err) {
      handleIpcError(err);
    }
  };

  return (
    <Card>
      {renderCardHeader()}
      <CardContent className="flex flex-col gap-4">
        {/* AI 模型名称 */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-model" className="font-serif tracking-wide">
            AI 模型
          </Label>
          <Input
            id="ai-model"
            value={aiModel}
            onChange={(e) => setAiModel(e.target.value)}
            placeholder="如：deepseek-chat"
            disabled={isPending}
          />
        </div>
        {/* temperature + max_tokens：两列布局，等宽字体 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-temperature" className="font-mono text-xs tracking-wide">
              Temperature
            </Label>
            <Input
              id="ai-temperature"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={aiTemperature}
              onChange={(e) => setAiTemperature(e.target.value)}
              disabled={isPending}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ai-max-tokens" className="font-mono text-xs tracking-wide">
              Max Tokens
            </Label>
            <Input
              id="ai-max-tokens"
              type="number"
              step="100"
              min="100"
              max="32768"
              value={aiMaxTokens}
              onChange={(e) => setAiMaxTokens(e.target.value)}
              disabled={isPending}
              className="font-mono"
            />
          </div>
        </div>
        {/* RAG 开关：使用原生 checkbox（项目无 shadcn Checkbox 组件） */}
        <Label
          htmlFor="rag-enabled"
          className="font-serif flex cursor-pointer items-center gap-2 tracking-wide"
        >
          <input
            id="rag-enabled"
            type="checkbox"
            checked={ragEnabled}
            onChange={(e) => setRagEnabled(e.target.checked)}
            disabled={isPending}
          />
          启用 RAG 检索增强
        </Label>
        {/* RAG 参数：仅 ragEnabled=true 时可编辑 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rag-top-k" className="font-mono text-xs tracking-wide">
              Top K
            </Label>
            <Input
              id="rag-top-k"
              type="number"
              min="1"
              max="50"
              value={ragTopK}
              onChange={(e) => setRagTopK(e.target.value)}
              disabled={isPending || !ragEnabled}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rag-threshold" className="font-mono text-xs tracking-wide">
              Threshold
            </Label>
            <Input
              id="rag-threshold"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={ragThreshold}
              onChange={(e) => setRagThreshold(e.target.value)}
              disabled={isPending || !ragEnabled}
              className="font-mono"
            />
          </div>
        </div>
        {/* 保存按钮：右对齐 */}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void handleSave()} disabled={isPending}>
            {isPending ? '保存中...' : '保存'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
