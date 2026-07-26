// src/renderer/components/novel/ReviewReportPanel.tsx
// 审查报告面板组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 评分可视化 + 问题列表
// - 加载/审查按钮
// ──────────────────────────────────────────────────────────────

import { AlertCircle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { type ReactElement, useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface ReviewReportPanelProps {
  projectId: string;
}

const SEVERITY_CONFIG = {
  critical: { color: 'bg-red-500/10 text-red-500 border-red-500/30', label: '严重' },
  high: { color: 'bg-orange-500/10 text-orange-500 border-orange-500/30', label: '重要' },
  medium: { color: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30', label: '中等' },
  low: { color: 'bg-blue-500/10 text-blue-500 border-blue-500/30', label: '轻微' },
} as const;

export function ReviewReportPanel({ projectId: _projectId }: ReviewReportPanelProps): ReactElement {
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [loading, setLoading] = useState(false);

  const handleReview = useCallback(async () => {
    setLoading(true);
    // 模拟审查流程（实际接入 ReviewerAgent 后替换）
    setTimeout(() => {
      const mockReport: ReviewReport = {
        overallScore: 78,
        dimensions: [
          { name: '设定一致性', score: 82, maxScore: 100, comment: '整体设定较为一致' },
          { name: '逻辑连贯性', score: 75, maxScore: 100, comment: '部分情节逻辑可优化' },
          { name: '角色行为', score: 80, maxScore: 100, comment: '角色行为基本合理' },
          { name: '文风表达', score: 85, maxScore: 100, comment: '文笔流畅' },
          { name: '节奏把控', score: 70, maxScore: 100, comment: '部分段落节奏偏慢' },
        ],
        issues: [
          {
            severity: 'medium',
            category: '设定矛盾',
            description: '前一章主角修为为筑基期，本章提到金丹期技能',
            suggestion: '建议检查修为设定时间线，确保与大纲一致',
            location: { chapterId: '' },
          },
          {
            severity: 'low',
            category: '文风表达',
            description: '连续三段以"他"开头，句式略显单调',
            suggestion: '调整部分句首，增加环境与动作描写',
          },
        ],
        summary: '整体质量良好，建议重点关注设定一致性和节奏把控。',
      };
      setReport(mockReport);
      setLoading(false);
      toast.success('审查完成');
    }, 2000);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">审查报告</span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={handleReview}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ShieldAlert className="size-3" />
          )}
          {loading ? '审查中...' : '开始审查'}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {report === null ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-8">
            <ShieldAlert className="size-8 opacity-30" />
            <p className="text-xs">点击「开始审查」分析当前章节</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-3">
            {/* 总体评分 */}
            <div className="bg-card border-primary/20 flex flex-col items-center gap-1 rounded-lg border p-3">
              <div className="text-foreground text-2xl font-bold">{report.overallScore}</div>
              <div className="text-muted-foreground text-[10px]">总体评分</div>
              {/* 简易评分条 */}
              <div className="bg-secondary h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full rounded-full transition-all"
                  style={{ width: `${report.overallScore}%` }}
                />
              </div>
            </div>

            {/* 维度评分 */}
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs font-medium">维度评分</span>
              {report.dimensions.map((dim) => (
                <div key={dim.name} className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0 text-[10px]">
                    {dim.name}
                  </span>
                  <div className="bg-secondary h-1.5 flex-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${(dim.score / dim.maxScore) * 100}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-6 text-right text-[10px]">
                    {dim.score}
                  </span>
                </div>
              ))}
            </div>

            {/* 审查摘要 */}
            <div className="bg-card rounded-lg border p-2.5">
              <div className="text-muted-foreground mb-1 text-[10px] font-medium">审查摘要</div>
              <p className="text-foreground text-xs leading-relaxed">{report.summary}</p>
            </div>

            {/* 问题列表 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs font-medium">
                发现问题 ({report.issues.length})
              </span>
              {report.issues.length === 0 ? (
                <div className="flex items-center gap-1.5 py-2">
                  <CheckCircle2 className="size-3 text-green-500" />
                  <span className="text-muted-foreground text-xs">未发现明显问题</span>
                </div>
              ) : (
                report.issues.map((issue, idx) => {
                  const sev = SEVERITY_CONFIG[issue.severity];
                  return (
                    <div
                      key={idx}
                      className={cn('rounded-lg border p-2', sev.color.replace('text-', 'border-').split(' ')[2] || '')}
                    >
                      <div className="mb-1 flex items-center gap-1">
                        <AlertCircle className="size-2.5" />
                        <span className="text-[10px] font-medium">{sev.label}</span>
                        <span className="text-muted-foreground text-[10px]">· {issue.category}</span>
                      </div>
                      <p className="text-xs">{issue.description}</p>
                      <p className="text-muted-foreground mt-0.5 text-[10px]">
                        建议: {issue.suggestion}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

export default ReviewReportPanel;
