// src/main/infra/ai/memory-service.ts
// 跨会话记忆服务：LLM 提取 → 存储 → 召回注入（对齐 qwen channel-memory 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 回合结束后从转录提取记忆条目（fact/preference，LLM 判定 + 敏感过滤）
// - 记忆存储（memories 表，按 sourceTurnId 去重）
// - 会话开始时召回（注入 systemPrompt，由 agent-service 组装处调用）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/memory/
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// ChannelMemoryEntry（记忆条目）+ renderChannelMemoryRecall（召回注入）+
// scanForSecrets（敏感扫描）+ dream（周期性整理）语义，按我们的技术栈收敛重写：
// - 移除 proper-lockfile / Storage / 文件持久化（强耦合不搬运，改用 sqlite）
// - 敏感过滤收敛为规则匹配（api key / token / secret / password 模式）
// - dream 收敛为纯逻辑融合（token 相似度聚类；不依赖 LLM，保证确定性）
// ──────────────────────────────────────────────────────────────

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../../utils/logger';
import { getDb } from '../storage/db';
import type { MemoryRow } from '../storage/schema';
import { memories } from '../storage/schema';
import type { LlmClient } from './llm-client';

/** 记忆类别 */
export type MemoryKind = 'fact' | 'preference';

/** 记忆条目（共享类型投影） */
export interface MemoryEntry {
  readonly id: number;
  readonly sessionId: string;
  readonly content: string;
  readonly kind: MemoryKind;
  readonly createdAt: number;
}

/** dream 整理结果 */
export interface DreamResult {
  /** 融合组数（每组保留一条代表记忆） */
  readonly mergedGroups: number;
  /** 被合并删除的条目数 */
  readonly removedCount: number;
  /** 整理后剩余条目数 */
  readonly remainingCount: number;
}

/** 相似度聚类阈值（Jaccard，0-1） */
const DREAM_SIMILARITY_THRESHOLD = 0.35;

/** 融合摘要最大长度（防单条膨胀） */
const DREAM_MAX_CONTENT = 500;

/** 提取输出 schema（generateJson 结构化约束） */
const ExtractionOutputSchema = z.object({
  /** 用户陈述的事实（技术栈/偏好/项目约定等） */
  facts: z.array(z.string().max(200)).max(10),
  /** 用户表达的偏好（命名/风格/流程偏好等） */
  preferences: z.array(z.string().max(200)).max(10),
});

/** 提取提示词（系统）：不提取敏感信息 */
const EXTRACTION_SYSTEM_PROMPT = [
  '你是记忆提取器。从对话转录中提取值得跨会话记住的用户事实与偏好：',
  '- facts：用户陈述的事实（技术栈、项目约定、环境信息等）',
  '- preferences：用户表达的偏好（命名风格、工作流程、工具偏好等）',
  '规则：',
  '- 只提取明确陈述的内容，不推断',
  '- **绝不提取敏感信息**（API Key、token、密码、密钥、内网地址）',
  '- 忽略临时性内容（一次性指令、当前任务细节）',
  '仅返回 JSON：{"facts": [string], "preferences": [string]}',
].join('\n');

/** 敏感信息模式（对齐 qwen scanForSecrets 语义的收敛规则） */
const SENSITIVE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:api[_-]?key|apikey|access[_-]?token|secret|password|passwd)\b/i,
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI/DeepSeek 风格 key
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._-]{8,}\b/i,
]);

/**
 * 跨会话记忆服务（模块单例）
 */
export class MemoryService {
  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 召回会话记忆（注入上下文用；按创建时间倒序，最多 20 条）
   */
  async recall(sessionId: string): Promise<MemoryEntry[]> {
    const db = getDb();
    const rows = db
      .select()
      .from(memories)
      .where(eq(memories.sessionId, sessionId))
      .orderBy(memories.createdAt)
      .all();
    return rows.slice(-20).map(rowToEntry);
  }

  /**
   * 存储记忆条目（按 sourceTurnId 去重；单条内容敏感过滤后跳过）
   */
  async store(
    sessionId: string,
    entries: Array<{ content: string; kind: MemoryKind; sourceTurnId?: string }>,
  ): Promise<void> {
    const db = getDb();
    const now = Date.now();
    for (const entry of entries) {
      const content = entry.content.trim();
      if (content.length === 0 || isSensitive(content)) {
        continue;
      }
      // 来源回合去重：同回合同内容不重复存（同回合不同内容都存）
      if (entry.sourceTurnId !== undefined) {
        const existing = db
          .select()
          .from(memories)
          .where(eq(memories.sessionId, sessionId))
          .all()
          .find((row) => row.sourceTurnId === entry.sourceTurnId && row.content === content);
        if (existing !== undefined) {
          continue;
        }
      }
      db.insert(memories)
        .values({
          sessionId,
          content,
          kind: entry.kind,
          ...(entry.sourceTurnId !== undefined ? { sourceTurnId: entry.sourceTurnId } : {}),
          createdAt: now,
        })
        .run();
    }
  }

  /**
   * 清除会话记忆（幂等）
   */
  async clear(sessionId: string): Promise<void> {
    const db = getDb();
    db.delete(memories).where(eq(memories.sessionId, sessionId)).run();
    logger.info({ sessionId }, '会话记忆已清除');
  }

  /**
   * 记忆整理（dream）：相似记忆融合，防止重复条目膨胀
   *
   * 纯逻辑实现（不依赖 LLM，确定性可测）：
   * 1. 读取全部记忆（按创建时间升序）
   * 2. 贪心聚类：每条与已建组代表比较 Jaccard token 相似度
   * 3. 相似组（≥ 阈值）合并到代表条目（内容拼接 + 截断），其余删除
   *
   * @param sessionId 目标会话（缺省整理全部）
   */
  async dream(sessionId?: string): Promise<DreamResult> {
    const db = getDb();
    const rows = (
      sessionId !== undefined
        ? db.select().from(memories).where(eq(memories.sessionId, sessionId)).all()
        : db.select().from(memories).all()
    ).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

    // 贪心聚类：组代表（行）→ 组内待合并条目
    const groups: Array<{ representative: MemoryRow; merged: MemoryRow[] }> = [];
    for (const row of rows) {
      const match = groups.find(
        (group) =>
          tokenSimilarity(group.representative.content, row.content) >= DREAM_SIMILARITY_THRESHOLD,
      );
      if (match !== undefined) {
        match.merged.push(row);
      } else {
        groups.push({ representative: row, merged: [] });
      }
    }

    // 融合：代表条目拼接内容，删除组内其余
    let removedCount = 0;
    for (const group of groups) {
      if (group.merged.length === 0) {
        continue;
      }
      const fused = mergeContents(
        group.representative.content,
        group.merged.map((m) => m.content),
      );
      db.update(memories)
        .set({ content: fused })
        .where(eq(memories.id, group.representative.id))
        .run();
      for (const m of group.merged) {
        db.delete(memories).where(eq(memories.id, m.id)).run();
      }
      removedCount += group.merged.length;
    }

    const result: DreamResult = {
      mergedGroups: groups.filter((g) => g.merged.length > 0).length,
      removedCount,
      remainingCount: groups.length,
    };
    if (result.mergedGroups > 0) {
      logger.info(
        {
          mergedGroups: result.mergedGroups,
          removedCount: result.removedCount,
          remainingCount: result.remainingCount,
        },
        '记忆整理完成（dream）',
      );
    }
    return result;
  }

  /**
   * 从转录提取记忆条目（LLM 判定 + 敏感过滤；失败返回空列表，不阻断）
   *
   * @param sessionId 目标会话
   * @param transcript 回合转录文本
   * @param sourceTurnId 来源回合 id（去重）
   */
  async extractAndStore(
    sessionId: string,
    transcript: string,
    sourceTurnId?: string,
  ): Promise<void> {
    if (transcript.trim().length === 0) {
      return;
    }
    try {
      const output = await this.llmClient.generateJson({
        schema: ExtractionOutputSchema,
        prompt: `对话转录：\n${transcript.slice(0, 8000)}\n\n请提取值得记住的用户事实与偏好（仅 JSON 输出）。`,
        system: EXTRACTION_SYSTEM_PROMPT,
        maxAttempts: 1,
      });
      const entries: Array<{ content: string; kind: MemoryKind; sourceTurnId?: string }> = [
        ...output.facts.map((content) => ({ content, kind: 'fact' as const })),
        ...output.preferences.map((content) => ({ content, kind: 'preference' as const })),
      ];
      await this.store(
        sessionId,
        entries.map((e) => ({
          content: e.content,
          kind: e.kind,
          // exactOptionalPropertyTypes：sourceTurnId 未传时条件展开
          ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
        })),
      );
      if (entries.length > 0) {
        logger.info({ sessionId, extracted: entries.length }, '记忆提取完成');
      }
    } catch (err: unknown) {
      // 提取失败不阻断主流程（记忆是增强能力）
      logger.warn({ sessionId, error: err }, '记忆提取失败（静默）');
    }
  }
}

/** 行 → 共享类型 */
function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    kind: row.kind as MemoryKind,
    createdAt: row.createdAt,
  };
}

/**
 * token 集合：英文词 + 中文 bigram（中英混合文本的轻量相似度基础）
 *
 * 借鉴声明：分词思路参考 qwen dream 的相似度判定的收敛简化
 * （无 embedding 依赖；仅覆盖词形重叠，不追求语义相似）
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // 英文词 / 数字 / 下划线
  for (const word of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    tokens.add(word);
  }
  // 中文连续段 bigram
  for (const seg of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < seg.length - 1; i += 1) {
      tokens.add(seg.slice(i, i + 2));
    }
    if (seg.length === 1) {
      tokens.add(seg);
    }
  }
  return tokens;
}

/** Jaccard 相似度（0-1） */
export function tokenSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 融合内容：代表 + 新增去重拼接（截断上限） */
function mergeContents(base: string, additions: readonly string[]): string {
  const seen = new Set<string>([base]);
  const parts = [base];
  for (const addition of additions) {
    if (!seen.has(addition)) {
      seen.add(addition);
      parts.push(addition);
    }
  }
  const joined = parts.join('；');
  return joined.length <= DREAM_MAX_CONTENT ? joined : `${joined.slice(0, DREAM_MAX_CONTENT)}…`;
}

/** 敏感信息过滤（对齐 qwen scanForSecrets 语义收敛） */
function isSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
