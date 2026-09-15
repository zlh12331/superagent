// src/renderer/components/chat/question-jump-bar.tsx
// 消息跳转条（自 ChatMessageList 拆分，2026-09-15）
// ──────────────────────────────
// 拆分背景：原内联于 ChatMessageList（第二个组件与该文件「组装层」定位不符，
// 与已外移的 message-item/streaming-footer 做法不一致），按职责提取
// 设计（对齐参考项目 DeepSeek-Reasonix QuestionJumpBar）：磁性吸附（hover 按距离
// 涟漪放大）+ 整轨热区（吸附最近锚点）+ 预览跟随鼠标
// ──────────────────────────────

import type { CSSProperties, ReactElement, MouseEvent as ReactMouseEvent } from 'react';
import { useRef, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';

import type { QuestionAnchor } from './use-message-nav-rail';

interface QuestionJumpBarProps {
  /** 用户消息锚点（全量） */
  readonly questions: readonly QuestionAnchor[];
  /** 当前活跃锚点 turn（滚动联动） */
  readonly activeTurn: number | null;
  /** 跳转回调（平滑滚动到消息） */
  readonly onJump: (question: QuestionAnchor) => void;
}

/**
 * 吸附测量（模块级提取：纯几何计算，不依赖组件状态）
 *
 * 找到离指针最近的锚点（整轨热区——无需精确点中横条），返回锚点与预览条 y 偏移。
 */
function closestQuestionFromY(
  el: HTMLElement,
  questions: readonly QuestionAnchor[],
  clientY: number,
): { question: QuestionAnchor; previewY: number } | null {
  const markers = el.querySelectorAll<HTMLElement>('.jump-item');
  const barRect = el.getBoundingClientRect();
  let closest = -1;
  let closestDist = Infinity;
  let closestY = 0;
  markers.forEach((item, index) => {
    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const dist = Math.abs(clientY - midY);
    if (dist < closestDist) {
      closestDist = dist;
      closest = index;
      closestY = midY - barRect.top;
    }
  });
  const question = questions[closest];
  if (question === undefined) return null;
  return { question, previewY: closestY };
}

/** 磁性宽度：按与 hover 锚点的距离分档（d=距离；0 档涟漪最大） */
function magneticWidth(d: number, isActive: boolean): number {
  if (d === 0) return 32;
  if (d === 1) return 20;
  if (d === 2) return 14;
  return isActive ? 18 : 12;
}

/**
 * 磁性宽度/颜色（模块级提取：纯样式计算）
 *
 * 未 hover 时仅 active 加宽；hover 时按距离涟漪级联（transitionDelay 错峰）。
 */
function dotMetrics(
  idx: number,
  turn: number,
  hoverIdx: number,
  activeTurn: number | null,
): { style: CSSProperties; 'data-d'?: string } {
  const isActive = activeTurn === turn;
  if (hoverIdx < 0) {
    return isActive
      ? { style: { width: 18, background: 'var(--accent)' } }
      : { style: { width: 12 } };
  }
  const d = Math.abs(idx - hoverIdx);
  const background = d <= 2 ? undefined : isActive ? 'var(--accent)' : undefined;
  return {
    style: {
      width: magneticWidth(d, isActive),
      transitionDelay: `${d * 20}ms`,
      ...(background !== undefined ? { background } : {}),
    },
    ...(d <= 2 ? { 'data-d': String(d) } : {}),
  };
}

/**
 * 消息跳转条
 *
 * 磁性吸附横条：鼠标在轨道上移动时按距离涟漪放大（最近 32px / 相邻 20px / 隔 1 个 14px），
 * 颜色按距离递减；预览跟随鼠标位置（role=tooltip）。
 * ──────────────────────────────
 * 变体：无
 * 状态：hovered（磁性目标）/ active（滚动联动）
 * 依赖：无（原生 div/button）
 * 可访问性：nav + button 键盘可达；jump-item focus-visible 光环；预览 role=tooltip
 * 备注：预览不用 shadcn Tooltip——Radix Tooltip 锚定触发器，无法实现"位置跟随鼠标"
 *       语义（参考项目同款交互），故用自研 div + role=tooltip（功能性例外）
 * ──────────────────────────────
 */
export function QuestionJumpBar({
  questions,
  activeTurn,
  onJump,
}: QuestionJumpBarProps): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  // 预览垂直位置用 state（曾用 ref：render 期读 ref 是 React 反模式，
  // 且 ref 变化不触发重渲染导致 tooltip 位置停留在旧值；React Compiler 也会因此跳过优化本组件）
  const [previewTop, setPreviewTop] = useState(0);
  const [showPreview, setShowPreview] = useState(false);

  const hoverIdx = hovered !== null ? questions.findIndex((q) => q.turn === hovered) : -1;
  const hoveredQuestion = hovered !== null ? questions.find((q) => q.turn === hovered) : undefined;

  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = barRef.current;
    if (el === null) return;
    const closest = closestQuestionFromY(el, questions, e.clientY);
    if (closest === null) return;
    setPreviewTop(closest.previewY);
    setHovered(closest.question.turn);
    setShowPreview(true);
  };

  const onRailMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = barRef.current;
    if (el === null) return;
    const closest = closestQuestionFromY(el, questions, e.clientY);
    if (closest === null) return;
    e.preventDefault();
    setPreviewTop(closest.previewY);
    setHovered(closest.question.turn);
    setShowPreview(true);
    onJump(closest.question);
  };

  const onItemMouseDown = (
    e: ReactMouseEvent<HTMLButtonElement>,
    question: QuestionAnchor,
  ): void => {
    e.preventDefault();
    onJump(question);
  };

  return (
    <nav
      className="jump-bar"
      ref={barRef}
      aria-label={t('chat.msgNavRail')}
      onMouseMove={onMove}
      onMouseLeave={() => {
        setHovered(null);
        setShowPreview(false);
      }}
    >
      {/* 轨道：整轨热区（吸附最近锚点点击跳转）；键盘路径由内部 jump-item button 提供，
          轨道点击为鼠标增强（对齐参考项目同款交互） */}
      {/* biome-ignore lint/a11y/useSemanticElements: role=group 滚动热区容器（非表单分组），fieldset 语义不符 */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户通过内部 jump-item 的 Enter/Space 跳转，轨道点击是鼠标增强路径 */}
      <div
        role="group"
        className="jump-scroll"
        onMouseDown={onRailMouseDown}
        onClick={onRailMouseDown}
      >
        {questions.map((question, index) => (
          <button
            className="jump-item"
            key={question.id}
            type="button"
            data-turn={question.turn}
            aria-label={`${t('chat.msgNavGoTo')} ${question.turn + 1}`}
            onMouseDown={(e) => onItemMouseDown(e, question)}
            onClick={(e) => {
              e.stopPropagation();
              // 键盘 Enter/Space 触发（e.detail === 0）；鼠标路径走 onMouseDown 避免与轨道点击冲突
              if (e.detail === 0) onJump(question);
            }}
          >
            <span
              className="jump-dot"
              {...dotMetrics(index, question.turn, hoverIdx, activeTurn)}
            />
          </button>
        ))}
      </div>
      {showPreview && hoveredQuestion !== undefined && (
        <div className="jump-preview" style={{ top: previewTop }} role="tooltip">
          <span className="jump-text">{hoveredQuestion.text}</span>
        </div>
      )}
    </nav>
  );
}
