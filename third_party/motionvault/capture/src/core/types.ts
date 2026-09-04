/**
 * MotionLens 核心类型契约 —— 所有模块（extract / sample / analyze / shells）共享。
 * 修改本文件 = 修改集成契约，需同步通知所有模块负责人。
 */

/** 提取来源：waapi/css/transition 为结构化提取；sampled 为样式采样回放；vision 为录屏+视觉模型兜底 */
export type CaptureSource = 'css' | 'transition' | 'waapi' | 'sampled' | 'vision';

export interface CapturedKeyframe {
  /** 0-1，transition 类可能为 null（仅有起止两帧） */
  offset: number | null;
  /** 该帧的 easing（WAAPI 支持逐帧 easing） */
  easing?: string;
  /** 属性名 → 值（CSS 字符串形式，如 transform: 'translateX(10px)'） */
  props: Record<string, string>;
}

export interface CapturedTiming {
  duration: number;        // ms
  delay: number;           // ms
  iterations: number;      // Infinity 表示无限循环
  direction?: string;      // normal / reverse / alternate ...
  fill?: string;           // none / forwards / both ...
  easing?: string;         // 整体 easing（CSS 动画在这里；WAAPI 可能在帧上）
}

export type TriggerKind = 'load' | 'hover' | 'click' | 'scroll' | 'unknown';

export interface TargetSummary {
  tag: string;
  classes: string[];
  id?: string;
  textSnippet?: string;    // 前 80 字符
  role?: string;
  childCount: number;
}

export interface CapturedAnimation {
  id: string;              // 模块内唯一
  source: CaptureSource;
  /** css animation-name（若有） */
  name?: string;
  keyframes: CapturedKeyframe[];
  timing: CapturedTiming;
  /** 目标元素的 CSS 选择器路径（body 起的简短路径） */
  targetPath: string;
  target: TargetSummary;
  trigger: TriggerKind;
}

/** 样式采样曲线：属性 → [时间ms, 数值] 序列（数值为分解后的标量，如 translateX px、rotate deg、opacity 0-1） */
export interface SampleCurve {
  fps: number;
  durationMs: number;
  channels: Record<string, Array<[number, number]>>;
}

/** 采样拟合结果：识别出的动画片段 */
export interface FittedSegment {
  startMs: number;
  endMs: number;
  /** 属性 → 起止值 */
  channels: Record<string, { from: number; to: number }>;
  /** 拟合出的 easing（cubic-bezier(...) / linear / 知名曲线名） */
  easing: string;
  /** 拟合残差 0-1，越小越准 */
  error: number;
  /** 若为循环动画：单次周期 ms */
  periodMs?: number;
}

export interface CaptureReport {
  tool: { name: 'motionlens'; version: string };
  url: string;
  pageTitle: string;
  capturedAt: string;      // ISO
  viewport: { w: number; h: number };
  /** 目标元素视口内位置（截图裁剪用） */
  elementBox: { x: number; y: number; width: number; height: number };
  /** 目标元素关键 computed style（font/color/background/size 等上下文） */
  computedBase: Record<string, string>;
  /** 结构化提取到的动画（可能多条：元素自身 + 子元素） */
  animations: CapturedAnimation[];
  /** 采样曲线（structured 提取为空时的兜底 / 或并存） */
  sampled?: { curve: SampleCurve; segments: FittedSegment[] };
  /** 目标 DOM 片段（深度≤3、去 script/style、截断 4KB） */
  domSnippet: string;
  /** vision 兜底模式时的抽帧（dataURL jpeg，最多 8 帧） */
  frames?: string[];
}

/** 站点侧 Effect 条目的最小兼容集（对应 src/types/effect.ts 的元数据部分） */
export type CategoryId =
  | 'text' | 'card' | 'layout' | '3d' | 'particle' | 'background'
  | 'button' | 'scroll' | 'svg' | 'loader' | 'spring' | 'lab';

/** LLM 分析产出：可直接转为 MotionVault 数据条目的草稿 */
export interface EffectDraft {
  title: string;           // 中文名，如「磁吸按钮」
  titleEn: string;         // kebab-case id 建议，如 'magnetic-button'
  category: CategoryId;
  description: string;     // 一句话
  techTags: string[];      // ['css-keyframes', 'hover'] / ['gsap', 'scrolltrigger']
  principle: string;       // 实现原理拆解（2-4 句）
  prompt: string;          // 中文复现 prompt（可直接喂 Cursor/Claude）
  promptEn: string;        // 英文复现 prompt
  difficulty: 'easy' | 'medium' | 'hard';
  confidence: number;      // 0-1 自评置信度
  sourceUrl: string;
}

/** LLM provider 配置（BYOK） */
export interface AnalyzerOptions {
  provider: 'openai' | 'anthropic' | 'openai-compatible';
  apiKey: string;
  model?: string;                    // 默认 gpt-4o / claude-sonnet-4-5
  baseUrl?: string;                  // openai-compatible 时必填
  frames?: string[];                 // vision 模式抽帧
  signal?: AbortSignal;
}

export interface PickerOptions {
  /** 提示条文案 */
  hint?: string;
  /** 触发模式：点选后自动尝试 hover/合成事件以激活动效 */
  autoTrigger?: boolean;
  /** 从点选到收集结束的观察窗口 ms（默认 2600） */
  observeMs?: number;
}

export interface CaptureOptions extends PickerOptions {
  /** 结构化提取为空时是否自动启用采样兜底（默认 true） */
  sampleFallback?: boolean;
  /** 采样时长 ms（默认 3000） */
  sampleMs?: number;
  /** 用户点选完成后的回调（shell 层用它恢复面板并展示提取进度） */
  onPicked?: (el: Element) => void;
}
