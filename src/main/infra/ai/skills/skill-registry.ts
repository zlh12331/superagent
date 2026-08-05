// src/main/infra/ai/skills/skill-registry.ts
// 技能系统：可复用技能定义 + 注册表（对齐 qwen skills 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 技能定义（name/description/prompt 纯数据）
// - 内置技能注册表 + 按名加载（模型经 load_skill 工具获取提示词）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/skills/
// （Copyright 2025 Qwen，SPDX-License-Identifier: Apache-2.0）的
// SkillManager + SKILL.md 语义，按我们的技术栈收敛重写：
// - 移除 YAML frontmatter / 文件系统四级加载（强耦合不搬运）
// - 收敛为 TypeScript 内置技能注册表（用户技能目录加载标注后置）
// - 保留核心语义：模型通过专用工具（load_skill）按名加载技能提示词
// ──────────────────────────────────────────────────────────────

/**
 * 技能定义（纯数据）
 */
export interface Skill {
  /** 技能名（snake_case） */
  readonly name: string;
  /** 一句话描述（load_skill 工具选择依据） */
  readonly description: string;
  /** 技能提示词（注入上下文的指导内容） */
  readonly prompt: string;
}

/**
 * 内置技能集
 */
const BUILTIN_SKILLS: readonly Skill[] = Object.freeze([
  {
    name: 'code_review',
    description: '对代码变更进行系统化审查（正确性/安全/性能/风格）',
    prompt: [
      '你正在进行代码审查。按以下维度系统化检查：',
      '1. 正确性：边界条件、错误处理、资源释放、竞态',
      '2. 安全性：注入、路径遍历、敏感信息泄漏、权限绕过',
      '3. 性能：不必要的重复计算、N+1 查询、阻塞操作',
      '4. 可维护性：命名、重复代码、复杂度、文档',
      '对每个发现标注严重度（critical/warning/nit）并给出修复建议。',
    ].join('\n'),
  },
  {
    name: 'refactor',
    description: '安全重构代码（保持行为不变，小步验证）',
    prompt: [
      '你在进行安全重构。原则：',
      '1. 一次只做一类重构（重命名/提取/内联/移动）',
      '2. 重构前后行为必须完全一致',
      '3. 每次重构后提示验证方式（测试/编译/类型检查）',
      '4. 涉及公共 API 变更时说明影响面',
    ].join('\n'),
  },
  {
    name: 'debugging',
    description: '系统化调试（复现→假设→定位→验证）',
    prompt: [
      '你在进行系统化调试。流程：',
      '1. 复现：明确触发条件与期望/实际行为',
      '2. 假设：基于证据提出最可能的根因（不要猜测）',
      '3. 定位：用最小复现隔离问题（二分法/断点/日志）',
      '4. 验证：修复后证明问题消失且无回归',
      '每一步向用户说明当前假设与证据。',
    ].join('\n'),
  },
  {
    name: 'commit_message',
    description: '生成符合 Conventional Commits 的提交信息',
    prompt: [
      '你正在生成 git 提交信息。要求：',
      '1. 遵循 Conventional Commits（feat/fix/perf/refactor/docs/test/chore）',
      '2. 一行摘要（≤72 字符）+ 必要时正文说明动机',
      '3. 描述变更行为而非过程（"修复 X" 而非 "改了 X 文件"）',
      '4. 不包含类型之外的 scope 除非必要',
    ].join('\n'),
  },
]);

/**
 * 技能注册表（模块单例）
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>(BUILTIN_SKILLS.map((s) => [s.name, s]));

  /**
   * 列出全部技能（按名排序）
   */
  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 按名加载技能（不存在返回 undefined）
   */
  load(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 注册技能（覆盖同名；扩展用）
   */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }
}

/** 模块级单例 */
export const skillRegistry = new SkillRegistry();
