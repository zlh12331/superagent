/**
 * MotionLens LLM 分析器：CaptureReport → EffectDraft。
 * 编排：空检查 → prompts 构建 → client.chat（含重试） → validateEffectDraft → 返回。
 */
import type { CaptureReport, EffectDraft, AnalyzerOptions } from '../core/types';
import { buildPrompts } from './prompts';
import { chat } from './client';
import { validateEffectDraft } from './schema';

export { validateEffectDraft, SchemaError } from './schema';
export { buildPrompts, SYSTEM_PROMPT, truncateReportJson, REPORT_JSON_LIMIT, STACK_CONSTRAINT } from './prompts';
export { chat, extractJsonObject, AnalyzerHttpError, ParseError } from './client';
export type { CaptureReport, EffectDraft, AnalyzerOptions } from '../core/types';

/**
 * 分析一次捕获报告，产出结构化 EffectDraft。
 * - report.animations 为空且无 frames（vision 兜底）时直接抛错，不调用 LLM。
 * - vision 模式：opts.frames 或 report.frames 作为图片输入（openai/anthropic 支持）。
 */
export async function analyzeCapture(report: CaptureReport, opts: AnalyzerOptions): Promise<EffectDraft> {
  const frames = opts.frames ?? report.frames;
  const hasAnimations = Array.isArray(report.animations) && report.animations.length > 0;
  const hasFrames = Array.isArray(frames) && frames.length > 0;

  if (!hasAnimations && !hasFrames) {
    throw new Error(
      'analyzeCapture: CaptureReport 既没有结构化 animations 也没有 vision 抽帧 frames，无法分析（不会调用 LLM）'
    );
  }

  const { system, user } = buildPrompts(report);
  const { json } = await chat({ system, user, opts, frames: hasAnimations ? undefined : frames });
  return validateEffectDraft(json, report);
}
