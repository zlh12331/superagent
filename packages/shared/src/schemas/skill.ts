// packages/shared/src/schemas/skill.ts
// 技能系统域（skill:list / learn / listLearned / removeLearned）
// ──────────────────────────────────────────────
// 设计：技能为纯数据（name/description/prompt），内置注册表 + SQLite learned 提供
// ──────────────────────────────────────────────

import { z } from 'zod';

export interface SkillInfo {
  /** 技能名（snake_case） */
  readonly name: string;
  /** 一句话描述 */
  readonly description: string;
}

/** skill:list 响应 payload */
export interface SkillListRes {
  readonly skills: readonly SkillInfo[];
}

/** skill:list 响应 zod schema（R3：响应契约校验） */
export const SkillListResSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
});

/** skill:learn 入参 schema */
export const SkillLearnReqSchema = z.object({
  rawInput: z.string().min(1).max(8000),
});

/** skill:learn 响应 zod schema（R3：响应契约校验） */
export const SkillLearnResSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  replaced: z.boolean(),
});

/** skill:listLearned 响应 zod schema（R3：响应契约校验） */
export const SkillListLearnedResSchema = z.array(
  z.object({ name: z.string(), description: z.string(), prompt: z.string() }),
);

/** skill:removeLearned 入参 schema */
export const SkillRemoveReqSchema = z.object({
  name: z.string().min(1).max(64),
});

/** skill:removeLearned 响应 zod schema（R3：响应契约校验） */
export const SkillRemoveLearnedResSchema = z.object({
  removed: z.boolean(),
});
