// src/main/infra/novel/reviewer-agent.ts
// ReviewerAgent：网文审查 AI Agent，对章节进行结构化审查
//
// 职责：
// 1. 分析章节内容，从多个维度评分（设定矛盾、逻辑问题、角色行为一致、文风等）
// 2. 输出结构化审查报告（JSON 格式）
// 3. 包含 JSON 回退解析逻辑（LLM 可能输出 markdown 包裹或格式不标准的 JSON）

import { generateText } from 'ai';
import { getModel } from '../ai/ai-provider';
import type { ReviewChapterParams, ReviewReport } from './types';

/**
 * ReviewerAgent 接口
 *
 * 对指定章节执行结构化审查，返回包含维度评分和问题列表的审查报告。
 */
export interface ReviewerAgentInterface {
  /** 审查章节内容 */
  reviewChapter(params: ReviewChapterParams): Promise<ReviewReport>;
}

class ReviewerAgent implements ReviewerAgentInterface {
  async reviewChapter(params: ReviewChapterParams): Promise<ReviewReport> {
    const model = await getModel();
    const titleHint =
      params.chapterTitle !== undefined ? `\n章节标题：${params.chapterTitle}` : '';

    const result = await generateText({
      model,
      system: REVIEWER_SYSTEM_PROMPT,
      prompt: `请审查以下章节内容${titleHint}：\n\n${params.content}\n\n请按要求的 JSON 格式输出审查报告。`,
    });

    return parseReviewReport(result.text);
  }
}

/** ReviewerAgent 单例 */
let reviewerAgent: ReviewerAgent | null = null;

export function getReviewerAgent(): ReviewerAgentInterface {
  if (reviewerAgent === null) {
    reviewerAgent = new ReviewerAgent();
  }
  return reviewerAgent;
}

export function resetReviewerAgent(): void {
  reviewerAgent = null;
}

// ── Prompt ─────────────────────────────────────────

const REVIEWER_SYSTEM_PROMPT = `你是一位资深的网文编辑和审稿人。请对以下章节进行结构化审查。

## 审查维度
1. **设定一致性** — 检查是否有世界观、力量体系、时间线等设定矛盾
2. **逻辑合理性** — 检查情节推进是否符合逻辑，人物行为是否合理
3. **角色行为一致** — 检查角色言行是否符合其性格设定和成长轨迹
4. **文风与表达** — 评估语言流畅度、描写质量、节奏把控
5. **情节吸引力** — 评估章节的悬念设置、冲突张力和读者留存力

每个维度评分 1-10 分（10 分为满分）。

## 问题分级
- critical — 严重问题（如重大设定矛盾、角色OOC），必须修复
- high — 需要关注的问题（如逻辑漏洞），建议修复
- medium — 一般问题（如表达不佳），可供参考
- low — 轻微问题（如用词不当），仅作建议

## 输出格式
请严格按以下 JSON 结构输出（不要加 markdown 代码块包裹，直接输出 JSON）：

{
  "dimensions": [
    { "name": "设定一致性", "score": 8, "comment": "评分说明" },
    { "name": "逻辑合理性", "score": 7, "comment": "评分说明" },
    { "name": "角色行为一致", "score": 9, "comment": "评分说明" },
    { "name": "文风与表达", "score": 8, "comment": "评分说明" },
    { "name": "情节吸引力", "score": 7, "comment": "评分说明" }
  ],
  "issues": [
    {
      "severity": "high",
      "description": "问题描述",
      "suggestion": "修改建议"
    }
  ],
  "overallScore": 7.8,
  "overallComment": "总体评价"
}`;

// ── JSON 解析与回退逻辑 ───────────────────────────

/**
 * 解析 LLM 返回的审查报告文本为 ReviewReport
 *
 * 处理以下常见 LLM 输出问题：
 * 1. markdown 代码包裹（\`\`\`json ... \`\`\`）
 * 2. 前后有多余文本
 * 3. JSON 格式不标准（如 trailing comma）
 * 4. JSON 完全解析失败时返回回退报告
 */
function parseReviewReport(text: string): ReviewReport {
  // 1. 尝试提取 JSON 部分
  const jsonStr = extractJsonString(text);

  if (jsonStr === null) {
    return fallbackReport('无法解析审查报告 JSON');
  }

  // 2. 尝试标准解析
  try {
    const parsed = JSON.parse(jsonStr);
    return normalizeReport(parsed);
  } catch {
    // 3. 尝试修复常见 JSON 问题后再次解析
    try {
      const repaired = repairJson(jsonStr);
      const parsed = JSON.parse(repaired);
      return normalizeReport(parsed);
    } catch {
      return fallbackReport('审查报告格式异常');
    }
  }
}

/**
 * 从文本中提取 JSON 字符串
 *
 * 处理：
 * - \`\`\`json ... \`\`\` 包裹
 * - \`\`\` ... \`\`\` 包裹
 * - 纯 JSON 文本
 */
function extractJsonString(text: string): string | null {
  const trimmed = text.trim();

  // 尝试匹配 markdown 代码块
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch !== null) {
    const captured = jsonBlockMatch[1];
    if (captured !== undefined) {
      return captured.trim();
    }
  }

  // 尝试直接解析为 JSON 对象（以 { 开头）
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

/**
 * 修复常见 JSON 格式问题
 *
 * - trailing comma
 * - 单引号代替双引号
 * - 未加引号的 key
 */
function repairJson(jsonStr: string): string {
  let repaired = jsonStr
    // 移除 trailing comma（在 } ] 前）
    .replace(/,\s*([}\]])/g, '$1')
    // 替换单引号为双引号（仅非转义单引号）
    .replace(/(?<!\\)'/g, '"')
    // 修复未加引号的 key（简单的启发式）
    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');

  return repaired;
}

/**
 * 规范化解析后的报告对象
 *
 * 验证字段完整性，补充缺失字段。
 */
function normalizeReport(raw: Record<string, unknown>): ReviewReport {
  const rawDimensions = raw['dimensions'];
  const dimensions = Array.isArray(rawDimensions)
    ? rawDimensions.map((d: Record<string, unknown>) => ({
        name: String(d['name'] ?? ''),
        score: Number(d['score'] ?? 0),
        comment: String(d['comment'] ?? ''),
      }))
    : [];

  const rawIssues = raw['issues'];
  const issues = Array.isArray(rawIssues)
    ? rawIssues.map((i: Record<string, unknown>) => ({
        severity: String(i['severity'] ?? 'medium'),
        description: String(i['description'] ?? ''),
        suggestion: String(i['suggestion'] ?? ''),
      }))
    : [];

  return {
    dimensions,
    issues,
    overallScore: Number(raw['overallScore'] ?? 0),
    overallComment: String(raw['overallComment'] ?? ''),
  };
}

/**
 * 生成回退审查报告
 *
 * 当 JSON 解析完全失败时使用，保证调用方始终能收到结构化的 ReviewReport。
 */
function fallbackReport(reason: string): ReviewReport {
  return {
    dimensions: [],
    issues: [
      {
        severity: 'high',
        description: `审查报告解析失败：${reason}`,
        suggestion: '请重试审查，或检查章节内容是否正常。',
      },
    ],
    overallScore: 0,
    overallComment: '审查报告解析失败，请重试。',
  };
}
