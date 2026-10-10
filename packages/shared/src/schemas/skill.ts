// skill.ts：技能域 IPC 契约——skill:list / learn / listLearned / removeLearned 的入参 schema 与响应形状
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）引用，注册层（src/main/ipc/register.ts）据
// resSchema 校验 handler 返回值（缺失即启动抛错）；渲染层经 src/renderer/lib/settings-ops.ts 调用。
// 技能 = 纯数据（name/description/prompt），来源两处：内置注册表 + SQLite learned 表（启动时并入注册表，
// 见 src/main/index.ts）；边界：本文件只定形状，注册表与 LLM 提炼/持久化都在 src/main/infra/ai/。

import { z } from 'zod';

// ────────── 技能条目与 skill:list（全部可用技能：内置注册表 + 已学）──────────

/** 技能条目（skill:list 响应条目） */
export interface SkillInfo {
  /** 技能名（snake_case）；技能的唯一标识——内置与已学技能共用同一命名空间，同名即覆盖 */
  readonly name: string;
  /** 一句话描述（技能面板列表的副标题，用它与 name 一起辨认条目） */
  readonly description: string;
}

/** skill:list 响应 payload */
export interface SkillListRes {
  readonly skills: readonly SkillInfo[];
}

/**
 * skill:list 响应 zod schema
 *
 * 只收 name/description——技能提示词（prompt）不在本响应内，它只由 load_skill 工具消费
 * （src/main/infra/ai/tools/load-skill.tool.ts）。
 */
export const SkillListResSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
});

// ────────── skill:learn：LLM 提炼新技能（覆盖同名即替换）──────────

/**
 * skill:learn 入参 zod schema
 *
 * rawInput 是待提炼的原始知识源（URL / 文件路径 / 文本描述均可），上限 8000 字符；
 * 实际拼接进 LLM 提示词时主进程另截断到 4000（src/main/infra/ai/knowledge/learn-skill-agent.ts），
 * 故这里的上限只防超长入参灌进 IPC，不是提示词长度。
 */
export const SkillLearnReqSchema = z.object({
  /** 知识源原文（rawInput）；1–8000 字符 */
  rawInput: z.string().min(1).max(8000),
});

/**
 * skill:learn 响应 zod schema
 *
 * prompt 在 learn 响应中下发（产物即提示词本身）；name 的合法性（snake_case / 长度）
 * 由主进程的 LLM 输出 schema 把关（src/main/infra/ai/knowledge/learn-skill-agent.ts），
 * 不在此重复设限——非法输出在落库前已抛错。
 */
export const SkillLearnResSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  /** 是否覆盖了同名既有技能（false = 新建）；主进程按插入前是否已有同名行判定 */
  replaced: z.boolean(),
});

// ────────── skill:listLearned：已学技能（skills 表全行）──────────

/**
 * skill:listLearned 响应 zod schema
 *
 * 裸数组（非 skill:list 那样的 { skills: [...] } 包装），消费方不可套用同一解构。
 * 含 prompt 而 skill:list 不含——这里列的就是 skills 表全行，prompt 是行的一部分；
 * 当前取值不过滤 source（表中只存 learned 行，写入路径唯一）。
 */
export const SkillListLearnedResSchema = z.array(
  z.object({ name: z.string(), description: z.string(), prompt: z.string() }),
);

// ────────── skill:removeLearned：删除已学技能 ──────────

/**
 * skill:removeLearned 入参 zod schema
 *
 * name 应取自 skill:listLearned 的返回；删的是 skills 表的行，不是内置技能——
 * 若该名与内置技能同名，注册表在删行后会回退内置定义（src/main/infra/ai/skills/skill-registry.ts 的 remove），
 * 内置能力不因删除丢失。
 */
export const SkillRemoveReqSchema = z.object({
  /** 技能名（1–64 字符上限仅作入参兜底，实际合法名远短于此） */
  name: z.string().min(1).max(64),
});

/** skill:removeLearned 响应 zod schema（响应契约校验用） */
export const SkillRemoveLearnedResSchema = z.object({
  /** 是否命中并删除；false = 该名在 skills 表中不存在，属正常结果而非错误 */
  removed: z.boolean(),
});
