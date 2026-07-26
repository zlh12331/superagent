// src/main/infra/ai/prompt/prompt-service.ts
// PromptService：System Prompt 模板的数据库 CRUD + 默认 prompt 初始化 + 动态上下文注入
// ──────────────────────────────────────────────────────────────
// 职责：
// - initialize()：创建 prompts 表 + 插入默认 Code Agent prompt（幂等）
// - getPrompt(id)：从数据库读取 prompt 模板
// - resolvePrompt(id, workingDir)：读取模板 + 注入动态上下文 → 返回完整 system prompt
// - listPrompts()：列出所有 prompt（未来供设置界面使用）
// - updatePrompt(id, content)：更新 prompt 内容（未来供设置界面使用）
//
// 设计原则：
// - 数据库存储：用户选择的方案，支持运行时编辑
// - 默认 prompt 注入：initialize 时插入 DEFAULT_CODE_AGENT_PROMPT
// - 动态上下文注入：每次 resolvePrompt 都重新收集环境信息
// - 失败容忍：数据库读取失败时回退到默认 prompt（硬编码在 default-prompt.ts）
// ──────────────────────────────────────────────────────────────

import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import { type PromptRow, prompts } from '../../storage/schema';
import { DEFAULT_CODE_AGENT_PROMPT } from './default-prompt';
import { type GitSummaryProvider, injectDynamicContext } from './dynamic-context';

/**
 * 默认 Code Agent prompt 的固定 ID
 *
 * 数据库主键，initialize 时用此 ID 插入。
 * 用户编辑后此 ID 的 content 会更新，但 ID 不变。
 */
export const DEFAULT_CODE_AGENT_PROMPT_ID = 'code-agent';

/**
 * PromptService 接口
 *
 * 解耦 AgentService / ServiceContainer 对具体类的依赖：
 * - 单元测试：注入 mock 实现，不依赖真实 SQLite
 * - 未来扩展：支持基于远程配置中心的 prompt 同步
 *
 * 与 IAgentService / IChatService 的接口设计模式一致。
 */
export interface IPromptService {
  /** 初始化默认 prompt（幂等，重复调用安全） */
  initialize(): void;
  /**
   * 解析 prompt：读取模板 + 注入动态上下文
   *
   * @param id prompt ID（默认 'code-agent'）
   * @param workingDir 工作目录（用于收集 git/AGENTS.md 等动态上下文）
   * @returns 解析后的 prompt（含动态上下文）
   */
  resolvePrompt(id: string | undefined, workingDir: string): Promise<ResolvedPrompt>;
}

/**
 * PromptService 依赖选项
 */
export interface PromptServiceOptions {
  /**
   * Git 状态查询函数（可选）
   *
   * 注入而非直接依赖 GitService：
   * - 解耦对 ServiceContainer 的依赖
   * - 便于测试 mock
   *
   * 不传则 prompt 中 git 状态显示"未知"。
   */
  readonly gitSummaryProvider?: GitSummaryProvider;
}

/**
 * Prompt 解析结果
 */
export interface ResolvedPrompt {
  /** 完整的 system prompt（已注入动态上下文） */
  readonly content: string;
  /** prompt 来源（'database' / 'default-fallback'） */
  readonly source: 'database' | 'default-fallback';
}

/**
 * PromptService：管理 System Prompt 的数据库存储与动态上下文注入
 *
 * 生命周期：
 * - initialize()：应用启动时调用，幂等建表 + 插入默认 prompt
 * - resolvePrompt()：每次 agent:run 时调用，读取模板 + 注入上下文
 * - getPrompt() / listPrompts() / updatePrompt()：供未来设置界面使用
 */
export class PromptService implements IPromptService {
  /** 标记 initialize 是否已执行（避免重复插入） */
  private initialized = false;
  /** Git 状态查询函数（可选，未注入时为 undefined） */
  private readonly gitSummaryProvider: GitSummaryProvider | undefined;

  constructor(options: PromptServiceOptions = {}) {
    this.gitSummaryProvider = options.gitSummaryProvider;
  }

  /**
   * 初始化：插入默认 prompt（幂等）
   *
   * 在 initDb 之后调用一次。如果 prompts 表已有默认 prompt 则跳过。
   * 用户编辑过的 prompt 不会被覆盖（用 INSERT OR IGNORE）。
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    try {
      const db = getDb();
      const now = Date.now();

      // INSERT OR IGNORE：已存在则跳过（幂等）
      // 不用 INSERT OR REPLACE：避免覆盖用户编辑过的内容
      db.insert(prompts)
        .values({
          id: DEFAULT_CODE_AGENT_PROMPT_ID,
          name: 'Code Agent',
          description: '通用代码助手默认行为',
          role: 'code-agent',
          content: DEFAULT_CODE_AGENT_PROMPT,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      this.initialized = true;
      logger.info({}, 'PromptService 初始化完成');
    } catch (error) {
      // L6 修复：失败时不设 initialized=true，允许下次调用 initialize 重试
      // - 原实现：catch 块末尾设 initialized=true，导致 DB 临时不可用（如文件锁）
      //   后下次 initialize 直接 return，永远走 fallback，无法自愈
      // - 修复后：保持 initialized=false，下次调用会重新尝试插入
      // - 不影响运行时：resolvePrompt 已内置 fallback 到 DEFAULT_CODE_AGENT_PROMPT
      //   数据库读取失败时仍能正常工作
      logger.error({ error }, 'PromptService 初始化失败，下次调用将重试');
    }
  }

  /**
   * 读取 prompt 模板（不含动态上下文）
   *
   * @param id prompt ID（如 'code-agent'）
   * @returns prompt 行；不存在返回 null
   */
  getPrompt(id: string): PromptRow | null {
    try {
      const db = getDb();
      const result = db.select().from(prompts).where(eq(prompts.id, id)).get();
      return result ?? null;
    } catch (error) {
      logger.error({ error, promptId: id }, '读取 prompt 失败');
      return null;
    }
  }

  /**
   * 列出所有 prompt
   *
   * 供未来设置界面使用。
   */
  listPrompts(): PromptRow[] {
    try {
      const db = getDb();
      return db.select().from(prompts).all();
    } catch (error) {
      logger.error({ error }, '列出 prompt 失败');
      return [];
    }
  }

  /**
   * 更新 prompt 内容
   *
   * 供未来设置界面使用。
   *
   * @param id prompt ID
   * @param content 新的 prompt 内容
   * @returns 是否成功
   */
  updatePrompt(id: string, content: string): boolean {
    try {
      const db = getDb();
      const result = db
        .update(prompts)
        .set({ content, updatedAt: Date.now() })
        .where(eq(prompts.id, id))
        .run();
      return result.changes > 0;
    } catch (error) {
      logger.error({ error, promptId: id }, '更新 prompt 失败');
      return false;
    }
  }

  /**
   * 解析 prompt：读取模板 + 注入动态上下文
   *
   * 这是 AgentService 调用的入口：
   * 1. 从数据库读取指定 ID 的 prompt 模板
   * 2. 如果数据库读取失败，回退到硬编码默认值
   * 3. 调用 injectDynamicContext 注入环境信息 + Git 状态 + AGENTS.md
   *
   * @param id prompt ID（默认 'code-agent'）
   * @param workingDir 工作目录（用于收集动态上下文）
   * @returns 解析后的 prompt（含动态上下文）
   */
  async resolvePrompt(
    id: string = DEFAULT_CODE_AGENT_PROMPT_ID,
    workingDir: string,
  ): Promise<ResolvedPrompt> {
    // 1. 从数据库读取模板
    const row = this.getPrompt(id);
    let template: string;
    let source: 'database' | 'default-fallback';

    if (row !== null) {
      template = row.content;
      source = 'database';
    } else {
      // 数据库读取失败，回退到硬编码默认值
      logger.warn({ promptId: id }, '数据库中未找到 prompt，回退到硬编码默认值');
      template = DEFAULT_CODE_AGENT_PROMPT;
      source = 'default-fallback';
    }

    // 2. 注入动态上下文
    const content = await injectDynamicContext(template, {
      workingDir,
      ...(this.gitSummaryProvider !== undefined
        ? { gitSummaryProvider: this.gitSummaryProvider }
        : {}),
    });

    return { content, source };
  }
}
