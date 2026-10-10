import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import { type PromptRow, prompts } from '../../storage/schema';
import { DEFAULT_CODE_AGENT_PROMPT } from './default-prompt';
import { type GitSummaryProvider, injectDynamicContext } from './dynamic-context';

export const DEFAULT_CODE_AGENT_PROMPT_ID = 'code-agent';

export interface IPromptService {
  initialize(): void;
  resolvePrompt(id: string | undefined, workingDir: string): Promise<ResolvedPrompt>;
}

export interface PromptServiceOptions {
  readonly gitSummaryProvider?: GitSummaryProvider;
}

export interface ResolvedPrompt {
  readonly content: string;
  readonly source: 'database' | 'default-fallback';
}

export class PromptService implements IPromptService {
  private initialized = false;
  private readonly gitSummaryProvider: GitSummaryProvider | undefined;

  constructor(options: PromptServiceOptions = {}) {
    this.gitSummaryProvider = options.gitSummaryProvider;
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }

    try {
      const db = getDb();
      const now = Date.now();

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
      logger.error({ error }, 'PromptService 初始化失败，下次调用将重试');
    }
  }

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

  listPrompts(): PromptRow[] {
    try {
      const db = getDb();
      return db.select().from(prompts).all();
    } catch (error) {
      logger.error({ error }, '列出 prompt 失败');
      return [];
    }
  }

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

  async resolvePrompt(
    id: string = DEFAULT_CODE_AGENT_PROMPT_ID,
    workingDir: string,
  ): Promise<ResolvedPrompt> {
    const row = this.getPrompt(id);
    let template: string;
    let source: 'database' | 'default-fallback';

    if (row !== null) {
      template = row.content;
      source = 'database';
    } else {
      logger.warn({ promptId: id }, '数据库中未找到 prompt，回退到硬编码默认值');
      template = DEFAULT_CODE_AGENT_PROMPT;
      source = 'default-fallback';
    }

    const content = await injectDynamicContext(template, {
      workingDir,
      ...(this.gitSummaryProvider !== undefined
        ? { gitSummaryProvider: this.gitSummaryProvider }
        : {}),
    });

    return { content, source };
  }
}
