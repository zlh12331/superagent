// packages/shared/src/schemas/skill.ts
// 技能系统域（skill:list）
// ──────────────────────────────────────────────
// 设计：技能为纯数据（name/description/prompt），内置注册表提供
// ──────────────────────────────────────────────

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
