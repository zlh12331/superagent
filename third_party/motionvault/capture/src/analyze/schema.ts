/**
 * EffectDraft 手写运行时校验器（不引 zod —— 产出要跑在扩展/书签环境）。
 * 职责：把 LLM 的原始 JSON 输出收敛为合法的 EffectDraft，能修的修，修不了的抛 SchemaError。
 */
import type { CaptureReport, CategoryId, EffectDraft } from '../core/types';

export class SchemaError extends Error {
  readonly raw: unknown;
  constructor(message: string, raw: unknown) {
    super(message);
    this.name = 'SchemaError';
    this.raw = raw;
  }
}

const CATEGORY_IDS: readonly CategoryId[] = [
  'text', 'card', 'layout', '3d', 'particle', 'background',
  'button', 'scroll', 'svg', 'loader', 'spring', 'lab',
];

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

/** 非法 category 时按 techTags 做一次启发式修正（命中顺序即优先级） */
const TAG_TO_CATEGORY: Array<[RegExp, CategoryId]> = [
  [/scroll|scrolltrigger|locomotive|lenis/i, 'scroll'],
  [/svg|lottie/i, 'svg'],
  [/loader|spinner|skeleton|loading/i, 'loader'],
  [/spring|物理|elastic|bounce/i, 'spring'],
  [/particle|particles|confetti|emitter/i, 'particle'],
  [/webgl|three|shader|3d|perspective|rotate[xyz]/i, '3d'],
  [/text|typography|char|word|letter|split/i, 'text'],
  [/button|btn|magnet|ripple/i, 'button'],
  [/card|hover|tilt|shadow/i, 'card'],
  [/background|gradient|aurora|mesh/i, 'background'],
  [/layout|grid|masonry|stagger-list/i, 'layout'],
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

function normalizeTechTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

function fixCategory(rawCat: unknown, techTags: string[]): CategoryId {
  if (typeof rawCat === 'string' && (CATEGORY_IDS as readonly string[]).includes(rawCat)) {
    return rawCat as CategoryId;
  }
  const joined = techTags.join(' ');
  for (const [re, cat] of TAG_TO_CATEGORY) {
    if (re.test(joined)) return cat;
  }
  return 'lab'; // 兜底：实验性/难以归类
}

function normalizeDifficulty(v: unknown): EffectDraft['difficulty'] {
  return (DIFFICULTIES as readonly string[]).includes(v as string)
    ? (v as EffectDraft['difficulty'])
    : 'medium';
}

/** kebab-case 兜底：LLM 偶尔给空格或大写 */
function normalizeTitleEn(v: unknown, fallbackTitle: string): string {
  const raw = asNonEmptyString(v);
  const base = raw ?? fallbackTitle;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled-effect';
}

/**
 * 校验并收敛 LLM 输出为 EffectDraft。
 * - category 非法 → 按 techTags 启发式修正一次，仍无命中 → 'lab'
 * - confidence 截断到 [0,1]；techTags 去重限 8 个
 * - title/description/principle/prompt/promptEn 必须非空，否则抛 SchemaError
 * - sourceUrl 一律从 report.url 回填（不信任模型输出）
 */
export function validateEffectDraft(raw: unknown, report: CaptureReport): EffectDraft {
  if (!isRecord(raw)) {
    throw new SchemaError('EffectDraft 不是 JSON 对象', raw);
  }
  const r = raw as Record<string, unknown>;

  const title = asNonEmptyString(r.title);
  const description = asNonEmptyString(r.description);
  const principle = asNonEmptyString(r.principle);
  const prompt = asNonEmptyString(r.prompt);
  const promptEn = asNonEmptyString(r.promptEn);

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!description) missing.push('description');
  if (!principle) missing.push('principle');
  if (!prompt) missing.push('prompt');
  if (!promptEn) missing.push('promptEn');
  if (missing.length > 0) {
    throw new SchemaError(`EffectDraft 缺少必填字段或字段为空: ${missing.join(', ')}`, raw);
  }

  const techTags = normalizeTechTags(r.techTags);

  return {
    title: title!,
    titleEn: normalizeTitleEn(r.titleEn, title!),
    category: fixCategory(r.category, techTags),
    description: description!,
    techTags,
    principle: principle!,
    prompt: prompt!,
    promptEn: promptEn!,
    difficulty: normalizeDifficulty(r.difficulty),
    confidence: clampConfidence(r.confidence),
    sourceUrl: report.url,
  };
}
