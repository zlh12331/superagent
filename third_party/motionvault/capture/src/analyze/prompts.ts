/**
 * LLM prompt 构建：system（角色+契约+分类体系）与 user（注入 CaptureReport + 输出要求）。
 */
import type { CaptureReport } from '../core/types';

/** user prompt 中注入的 report JSON 体积上限（字节，按 UTF-8 近似为字符数） */
export const REPORT_JSON_LIMIT = 12 * 1024;

export const SYSTEM_PROMPT = `你是一位资深前端动效工程师，擅长从动画参数（keyframes / timing / computed style / DOM 片段）反推实现技术栈，并写出可直接交给 AI 编码工具复现的 prompt。

# 输出契约
只输出一个严格合法的 JSON 对象，不要输出 markdown 围栏、注释或任何额外文字。字段清单：
- title: string，中文名，2-6 个字（如「磁吸按钮」「悬浮卡片」）
- titleEn: string，kebab-case 英文 id（如 "magnetic-button"）
- category: string，必须是下方 12 个分类 id 之一
- description: string，一句话中文描述（不超过 40 字）
- techTags: string[]，技术标签，从下方词表选 2-5 个
- principle: string，实现原理拆解，2-4 句中文，必须引用输入参数中的具体数值（时长/缓动/位移/颜色等）
- prompt: string，中文复现 prompt（见 user 消息中的具体要求）
- promptEn: string，与 prompt 同义的英文版
- difficulty: "easy" | "medium" | "hard"
- confidence: number，0-1，表示「仅凭这些参数能否准确复现该动效」的自评

# 分类体系（12 个 CategoryId，各一句话边界）
- text: 以文字/排版为动画主体的效果（逐字入场、打字机、文字形变、文字描边动画）
- card: 卡片容器的悬停/翻转/倾斜/阴影变化等微交互
- layout: 布局级动画（列表交错入场、网格重排、布局过渡 FLIP）
- 3d: 依赖 3D 变换、透视、WebGL/Three.js 的立体效果
- particle: 粒子系统、纸屑、星空、气泡等大量小元素的运动
- background: 页面/区块背景动画（渐变流动、极光、网格、噪点）
- button: 按钮类微交互（磁吸、涟漪、填充扫光、按压回弹）
- scroll: 由滚动驱动的效果（视差、滚动进度、ScrollTrigger 钉住）
- svg: SVG 路径描边、形变、Lottie 播放等矢量动画
- loader: 加载指示（spinner、骨架屏、进度条动画）
- spring: 以弹簧物理（stiffness/damping）为明显特征的拟物运动
- lab: 难以归入以上类别的实验性/复合效果

# 技术标签词表（建议）
css-keyframes, css-transition, waapi, gsap, scrolltrigger, framer-motion, raf, canvas, webgl, threejs, scroll, hover, click, loop, spring, svg, lottie, stagger, parallax, mask, clip-path, blur, gradient, 3d-transform

# 采样数据的可信度边界
report.sampled.segments 中 error > 0.3 的段，其 easing 标注不可信（锯齿/三角波循环会被误判为 spring/overshoot）；此时按 from/to 与 periodMs 定性描述运动（如「0.6s 循环起伏」），不要把 spring 写进复现 prompt`;

/** 复现 prompt 的技术栈约束，user 与 few-shot 共用，保持一致 */
export const STACK_CONSTRAINT =
  'React 19 + TypeScript，样式用 Tailwind 或原生 CSS，动画优先 framer-motion 或纯 CSS，禁止引入 UI 组件库';

/** few-shot：hover 放大 + 阴影加深的卡片（输入为简化 CaptureReport） */
const FEW_SHOT_INPUT = {
  url: 'https://example.com/pricing',
  pageTitle: 'Pricing',
  computedBase: { backgroundColor: 'rgb(255, 255, 255)', borderRadius: '12px', boxShadow: 'rgba(0,0,0,0.08) 0px 2px 8px' },
  animations: [
    {
      id: 'a1',
      source: 'transition',
      keyframes: [
        { offset: null, props: { transform: 'scale(1)', boxShadow: 'rgba(0,0,0,0.08) 0px 2px 8px' } },
        { offset: null, props: { transform: 'scale(1.04)', boxShadow: 'rgba(0,0,0,0.18) 0px 12px 32px' } },
      ],
      timing: { duration: 220, delay: 0, iterations: 1, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      targetPath: 'body > main > div.pricing-card',
      target: { tag: 'div', classes: ['pricing-card'], childCount: 4 },
      trigger: 'hover',
    },
  ],
  domSnippet: '<div class="pricing-card"><h3>Pro</h3><p>$19/mo</p></div>',
};

const FEW_SHOT_OUTPUT = {
  title: '悬浮卡片',
  titleEn: 'hover-lift-card',
  category: 'card',
  description: '悬停时卡片轻微放大并加深阴影的反馈效果',
  techTags: ['css-transition', 'hover'],
  principle:
    '这是一个 220ms 的 CSS transition 悬停微交互。触发后 transform 从 scale(1) 过渡到 scale(1.04)，同时 box-shadow 从 rgba(0,0,0,0.08) 0px 2px 8px 加深为 rgba(0,0,0,0.18) 0px 12px 32px，缓动为 cubic-bezier(0.2, 0.8, 0.2, 1)，先快后慢带来轻盈的回弹感。阴影模糊半径与透明度同步提升，制造出卡片「浮起」的高度错觉。',
  prompt: `用 ${STACK_CONSTRAINT} 实现一个悬停浮起的卡片组件：白色背景、圆角 12px，默认阴影 rgba(0,0,0,0.08) 0px 2px 8px；hover 时在 220ms 内用 cubic-bezier(0.2, 0.8, 0.2, 1) 缓动放大到 scale(1.04)，阴影同步变为 rgba(0,0,0,0.18) 0px 12px 32px；鼠标移出按相同参数回退。输出自包含单组件、零 props，卡片内放占位标题与价格文案。`,
  promptEn:
    'Build a self-contained React 19 + TypeScript hover-lift card component (Tailwind or plain CSS, framer-motion or pure CSS transitions, no UI libraries, zero props): white background, 12px radius, default box-shadow rgba(0,0,0,0.08) 0px 2px 8px. On hover, scale to 1.04 over 220ms with cubic-bezier(0.2, 0.8, 0.2, 1) while the shadow deepens to rgba(0,0,0,0.18) 0px 12px 32px; reverse with the same timing on mouse leave. Include placeholder title and price text inside the card.',
  difficulty: 'easy',
  confidence: 0.95,
};

/** 超限时按优先级截断 report 字段：animations > computedBase > domSnippet */
export function truncateReportJson(report: CaptureReport, limit: number = REPORT_JSON_LIMIT): string {
  const clone: Record<string, unknown> = { ...report };
  let json = JSON.stringify(clone);
  if (json.length <= limit) return json;

  // 1) animations 过多 → 从尾部裁剪数组
  const anims = clone.animations as unknown[] | undefined;
  if (Array.isArray(anims) && anims.length > 1) {
    let keep = anims.length;
    while (keep > 1 && json.length > limit) {
      keep = Math.max(1, Math.floor(keep / 2));
      clone.animations = anims.slice(0, keep);
      json = JSON.stringify(clone);
    }
    if (json.length <= limit) return json;
  }

  // 2) computedBase → 只保留头部键
  const base = clone.computedBase as Record<string, string> | undefined;
  if (base && typeof base === 'object') {
    let keys = Object.keys(base);
    while (keys.length > 4 && json.length > limit) {
      keys = keys.slice(0, Math.max(4, Math.floor(keys.length / 2)));
      const trimmed: Record<string, string> = {};
      for (const k of keys) trimmed[k] = base[k];
      clone.computedBase = trimmed;
      json = JSON.stringify(clone);
    }
    if (json.length <= limit) return json;
  }

  // 3) domSnippet → 硬截断
  if (typeof clone.domSnippet === 'string' && (clone.domSnippet as string).length > 0) {
    const overflow = json.length - limit + 32;
    const keep = Math.max(200, (clone.domSnippet as string).length - overflow);
    clone.domSnippet = (clone.domSnippet as string).slice(0, keep) + '…[truncated]';
    json = JSON.stringify(clone);
  }

  // 兜底：仍超限则整体截断（几乎不会发生）
  return json.length <= limit ? json : json.slice(0, limit);
}

export interface BuiltPrompts {
  system: string;
  user: string;
  /** true 表示 vision 兜底模式（无结构化 animations，仅有抽帧） */
  vision: boolean;
}

/**
 * 构建 user prompt。vision 模式（animations 为空且 frames 存在）改为帧描述任务。
 * 调用方需先保证 animations 非空或 frames 非空（index.ts 的空检查职责）。
 */
export function buildPrompts(report: CaptureReport): BuiltPrompts {
  const vision = report.animations.length === 0 && !!report.frames && report.frames.length > 0;

  const taskLines = vision
    ? [
        '# 输入模式：VISION（连续帧）',
        '本次没有结构化动画参数，只提供了目标元素的连续抽帧（作为图片输入）。',
        '请根据这些连续帧描述动效：观察帧间变化（位移/缩放/透明度/形变/颜色），推断触发方式、时序、缓动与循环特征，其余输出字段要求同下。',
        'confidence 应比结构化模式更保守（帧信息不完整）。',
      ]
    : [
        '# 输入：CaptureReport（结构化提取的动画参数）',
        '```json',
        truncateReportJson(report),
        '```',
      ];

  const user = [
    ...taskLines,
    '',
    '# 输出要求',
    '1. principle：用 2-4 句中文拆解实现手法（例：「双层 text-shadow 错位 + 0.6s cubic-bezier 回弹」），必须引用输入中的具体参数（duration/easing/关键帧数值/颜色值），禁止泛泛而谈。若数据来自采样回放（report.sampled），principle 需注明「（采样还原，参数近似）」。',
    `2. prompt：中文，可直接粘贴给 Cursor / Claude Code 使用。约束技术栈：「${STACK_CONSTRAINT}」。要求自包含单组件、零 props；明确描述触发方式（load/hover/click/scroll）、时序（duration/delay/stagger）、缓动曲线、关键属性起止值与颜色等关键参数。`,
    '3. promptEn：与 prompt 同义的英文版。',
    '4. title 用中文 2-6 字（如「磁吸按钮」），titleEn 用 kebab-case（如 "magnetic-button"）。',
    '5. confidence：对「仅凭这些参数能否准确复现该动效」自评 0-1。',
    '6. 若输入中有多条 animations，优先描述视觉效果最显著的一条，其余在 principle 中简要提及。',
    '',
    '# 示例',
    '输入（简化 CaptureReport）：',
    '```json',
    JSON.stringify(FEW_SHOT_INPUT, null, 2),
    '```',
    '输出：',
    '```json',
    JSON.stringify(FEW_SHOT_OUTPUT, null, 2),
    '```',
    '',
    '现在请对上面的真实输入输出你的 JSON。',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user, vision };
}
