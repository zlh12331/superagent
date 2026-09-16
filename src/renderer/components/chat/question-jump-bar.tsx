// src/renderer/components/chat/question-jump-bar.tsx
// 消息跳转条（自 ChatMessageList 拆分，2026-09-15）
// ──────────────────────────────
// 拆分背景：原内联于 ChatMessageList（第二个组件与该文件「组装层」定位不符，
// 与已外移的 message-item/streaming-footer 做法不一致），按职责提取
// 设计（对齐参考项目 DeepSeek-Reasonix QuestionJumpBar）：磁性吸附（hover 按距离
// 涟漪放大）+ 整轨热区（吸附最近锚点）+ 预览跟随鼠标
//
// 指针命中模型（2026-09 审计核实）：CSS 给 .jump-bar / .jump-item / .jump-dot 都是
// pointer-events:none，只有 .jump-scroll 是 auto ⇒ 真实鼠标事件**只**落在轨道上，
// 条目 button 从不接收指针事件。因此鼠标路径只有轨道一个处理器（天然单次跳转），
// 条目 button 仅服务键盘（Tab 聚焦 + Enter/Space → click 且 e.detail === 0）。
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

  /** 按指针 y 更新预览/高亮，返回命中的锚点（无命中返回 null） */
  const applyHoverAt = (clientY: number): QuestionAnchor | null => {
    const el = barRef.current;
    if (el === null) return null;
    const closest = closestQuestionFromY(el, questions, clientY);
    if (closest === null) return null;
    setPreviewTop(closest.previewY);
    setHovered(closest.question.turn);
    setShowPreview(true);
    return closest.question;
  };

  // 三个 setState 由 React 18+ 自动批处理为单次渲染，无需额外 rAF 合帧
  // （对比 use-message-nav-rail：那里 rAF 是必需的——scroll 事件高频且要读
  // 布局，属于不同问题）
  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    applyHoverAt(e.clientY);
  };

  const onRailMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // preventDefault 抑制 mousedown 的默认选中/拖拽行为；条目按钮是
    // pointer-events:none（见文件头），鼠标路径不会期望「聚焦某个圆点」
    e.preventDefault();
    const question = applyHoverAt(e.clientY);
    if (question !== null) onJump(question);
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
      {/* 轨道：整轨热区（吸附最近锚点跳转）。鼠标与键盘因此各只有一条路径：
          鼠标 → 本容器 onMouseDown；键盘 → 内部 jump-item button 的 click
          （e.detail === 0，浏览器对键盘激活的 click 设为 0）。 */}
      {/* biome-ignore lint/a11y/useSemanticElements: role=group 滚动热区容器（非表单分组），fieldset 语义不符 */}
      <div role="group" className="jump-scroll" onMouseDown={onRailMouseDown}>
        {questions.map((question, index) => (
          <button
            className="jump-item"
            key={question.id}
            type="button"
            aria-label={t('chat.msgNavGoTo', { n: question.turn + 1 })}
            onClick={(e) => {
              // 键盘 Enter/Space 触发（e.detail === 0）；鼠标路径由轨道 onMouseDown 承担
              if (e.detail === 0) onJump(question);
            }}
          >
            <span
              className="jump-dot"
              aria-hidden="true"
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
