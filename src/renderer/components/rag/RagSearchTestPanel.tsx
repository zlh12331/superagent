// src/renderer/components/rag/RagSearchTestPanel.tsx
// RAG 检索测试面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 顶部标题栏用 bg-sidebar 暖米色背景框
// - 标题用 font-serif 衬线字体
// - 分数颜色按文学风 token：高分(success) / 中分(warning) / 低分(muted)
// - 数字用 font-mono 等宽字体
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 提供查询文本 + topK + threshold 三个输入字段
// - 点击"搜索"调用 useRagSearch mutateAsync 进行检索
// - 渲染结果列表：每项展示 score 百分比 + content 前 200 字 + documentId
//
// 注意：
// - useRagSearch 为 mutation（非 useQuery），结果需用 useState 管理
// - topK 与 threshold 在 zod schema 中有 .default()，z.infer 推断为必填 number
//   → 提交时必须显式传值，不能用 ?? undefined
// - score 颜色映射：高分(success) / 中分(warning) / 低分(muted)，便于用户快速判断相似度
// - content 超过 200 字截断显示 "..."

import type { RagSearchResultItem } from '@novel-writer/shared';
import { Search } from 'lucide-react';
import type { ChangeEvent, ReactElement } from 'react';
import { useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useRagSearch } from '@/hooks/use-rag';
import { handleIpcError } from '@/lib/handle-ipc-error';

interface RagSearchTestPanelProps {
  /** 当前项目 ID */
  projectId: string;
}

/** content 截断长度（前 200 字） */
const CONTENT_MAX_LENGTH = 200;

/**
 * 根据相似度分数返回对应的 Tailwind 颜色类（文学风 token）
 *
 * - 高分（>= 0.8）：success（墨绿）
 * - 中分（>= 0.6）：warning（琥珀）
 * - 低分（< 0.6）：muted-foreground（灰墨）
 */
function getScoreColor(score: number): string {
  if (score >= 0.8) return 'text-success';
  if (score >= 0.6) return 'text-warning';
  return 'text-muted-foreground';
}

/**
 * 截断文本：超过 maxLength 字符则截断并追加省略号
 */
function truncateContent(content: string): string {
  if (content.length <= CONTENT_MAX_LENGTH) return content;
  // slice 不会越界报错，但返回类型仍为 string，安全
  return `${content.slice(0, CONTENT_MAX_LENGTH)}...`;
}

/**
 * RAG 检索测试面板
 *
 * @example
 * <RagSearchTestPanel projectId={projectId} />
 */
export function RagSearchTestPanel({ projectId }: RagSearchTestPanelProps): ReactElement {
  // 表单状态：查询文本 / topK / threshold
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [threshold, setThreshold] = useState(0.7);

  // 结果状态：useRagSearch 为 mutation，需手动管理结果与错误
  const [results, setResults] = useState<RagSearchResultItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const { mutateAsync, isPending } = useRagSearch();

  /**
   * topK 输入变化处理
   *
   * 命名说明：不使用 `handleTopKChange`，因 Biome useNamingConvention strictCase
   * 禁止 camelCase 中出现连续大写字母（'K' + 'C' 会触发报错），改为 `changeTopK`。
   *
   * 直接绑定到 Input type="number"：
   * - 输入为空字符串时 Number('') = 0，但 0 不在 [1, 50] 范围内
   * - 通过 clamp 把值限制在 [1, 50]，避免传给后端时被 zod 校验拒绝
   */
  const changeTopK = (e: ChangeEvent<HTMLInputElement>): void => {
    const value = Number(e.target.value);
    if (Number.isNaN(value)) return;
    // clamp 到 [1, 50]，与 zod schema 的 .int().positive().max(50) 一致
    const clamped = Math.min(50, Math.max(1, Math.floor(value)));
    setTopK(clamped);
  };

  /**
   * threshold 输入变化处理
   *
   * step=0.05，min=0，max=1，直接绑定到 Input type="number"。
   * 输入超界时 clamp 到 [0, 1]，避免传给后端被 zod 校验拒绝。
   */
  const handleThresholdChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const value = Number(e.target.value);
    if (Number.isNaN(value)) return;
    const clamped = Math.min(1, Math.max(0, value));
    setThreshold(clamped);
  };

  /**
   * 执行检索
   *
   * zod schema 中 topK 和 threshold 都有 .default()，
   * z.infer 推断为必填 number 类型，所以此处必须显式传值。
   */
  const handleSearch = async (): Promise<void> => {
    // 必填校验：查询文本不能为空
    if (query.trim().length === 0) return;
    // 清空上一次的错误，开始新一次检索
    setError(null);
    try {
      const data = await mutateAsync({
        projectId,
        query: query.trim(),
        topK,
        threshold,
      });
      setResults(data);
    } catch (err) {
      // 失败：通过 handleIpcError 显示 toast，同时设置 error 用于展示 ErrorState
      handleIpcError(err);
      setError(err);
      setResults(null);
    }
  };

  /** 是否有结果可展示（非 null 表示已检索过） */
  const hasSearched = results !== null;

  return (
    <section className="bg-card border-border flex h-full flex-col border">
      {/* 顶部标题栏：bg-sidebar 暖米色背景 + 衬线字体 */}
      <div className="border-sidebar-border bg-sidebar border-b p-3">
        <h2 className="text-foreground font-serif text-sm font-semibold tracking-wide">检索测试</h2>
      </div>

      {/* 查询表单：bg-sidebar 暖米色背景框 */}
      <div className="border-sidebar-border bg-sidebar flex flex-col gap-3 border-b p-3">
        {/* 查询文本 */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="rag-query" className="font-serif tracking-wide">
            查询文本 *
          </Label>
          <Textarea
            id="rag-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入查询文本，如：主角的能力体系"
            rows={3}
            disabled={isPending}
          />
        </div>
        {/* topK + threshold 双列 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rag-topk" className="font-mono text-xs tracking-wide">
              topK
            </Label>
            <Input
              id="rag-topk"
              type="number"
              min={1}
              max={50}
              value={topK}
              onChange={changeTopK}
              disabled={isPending}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rag-threshold" className="font-mono text-xs tracking-wide">
              threshold
            </Label>
            <Input
              id="rag-threshold"
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={threshold}
              onChange={handleThresholdChange}
              disabled={isPending}
              className="font-mono"
            />
          </div>
        </div>
        {/* 搜索按钮：查询文本为空时 disabled */}
        <Button
          size="sm"
          onClick={() => void handleSearch()}
          disabled={isPending || query.trim().length === 0}
        >
          <Search className="size-4" strokeWidth={1.5} />
          搜索
        </Button>
      </div>

      {/* 结果展示：加载中 / 错误 / 空 / 结果列表 */}
      <ScrollArea className="flex-1">
        <div className="p-3">
          {/* 加载中 */}
          {isPending && <LoadingSpinner label="检索中..." />}
          {/* 错误：带重试按钮 */}
          {!isPending && error !== null && (
            <ErrorState
              error={error}
              onRetry={() => {
                void handleSearch();
              }}
            />
          )}
          {/* 已检索但无结果 */}
          {!isPending &&
            error === null &&
            hasSearched &&
            results !== null &&
            results.length === 0 && (
              <EmptyState
                icon={<Search className="size-6" strokeWidth={1.5} />}
                title="无匹配切片"
                description="尝试调整查询文本或降低 threshold 阈值后重试"
              />
            )}
          {/* 已检索且有结果：列表展示 */}
          {!isPending &&
            error === null &&
            hasSearched &&
            results !== null &&
            results.length > 0 && (
              <ul className="flex flex-col gap-2">
                {results.map((item) => {
                  // 分数百分比：0~1 转为 0~100，四舍五入到整数
                  const scorePercent = Math.round(item.score * 100);
                  return (
                    <li
                      key={item.chunkId}
                      className="border-border bg-background rounded-md border p-2 text-xs"
                    >
                      {/* 第一行：分数 + 文档 ID */}
                      <div className="mb-1 flex items-center justify-between gap-2">
                        {/* 分数百分比：颜色随分数高→低（success→warning→muted），等宽字体 */}
                        <span
                          className={`font-mono text-sm font-medium tracking-wider ${getScoreColor(item.score)}`}
                        >
                          {scorePercent}%
                        </span>
                        {/* 文档 ID：截断显示，便于定位来源，等宽字体 */}
                        <span className="text-muted-foreground font-mono truncate text-[10px]">
                          {item.documentId}
                        </span>
                      </div>
                      {/* 第二行：内容（前 200 字），衬线字体 */}
                      <p className="text-foreground font-serif leading-relaxed whitespace-pre-wrap break-words">
                        {truncateContent(item.content)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          {/* 初始状态：未检索过 */}
          {!isPending && error === null && !hasSearched && (
            <EmptyState
              icon={<Search className="size-6" strokeWidth={1.5} />}
              title="输入查询开始检索"
              description="输入查询文本，调整 topK 和 threshold 后点击搜索"
            />
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
