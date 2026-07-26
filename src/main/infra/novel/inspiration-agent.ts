// src/main/infra/novel/inspiration-agent.ts
// InspirationAgent：灵感建议 AI Agent，基于当前章节上下文生成创意建议
//
// 职责：
// 1. 分析当前章节内容和上下文位置
// 2. 生成 3-5 个创意灵感建议（情节发展/人物刻画/冲突设计等方向）
// 3. 每个建议包含标题、描述和示例片段

import { generateText } from 'ai';
import { getModel } from '../ai/ai-provider';
import type { GetInspirationParams, InspirationSuggestion } from './types';

/**
 * InspirationAgent 接口
 *
 * 基于章节上下文生成创意建议，返回 3-5 个灵感建议。
 */
export interface InspirationAgentInterface {
  /** 获取灵感建议 */
  getInspiration(params: GetInspirationParams): Promise<InspirationSuggestion[]>;
}

class InspirationAgent implements InspirationAgentInterface {
  async getInspiration(params: GetInspirationParams): Promise<InspirationSuggestion[]> {
    const model = await getModel();

    const result = await generateText({
      model,
      system: INSPIRATION_SYSTEM_PROMPT,
      prompt: `以下为当前章节的内容：\n\n${params.context}\n\n请基于以上上下文提供创意建议，按要求的 JSON 格式输出。`,
    });

    return parseInspirationSuggestions(result.text);
  }
}

/** InspirationAgent 单例 */
let inspirationAgent: InspirationAgent | null = null;

export function getInspirationAgent(): InspirationAgentInterface {
  if (inspirationAgent === null) {
    inspirationAgent = new InspirationAgent();
  }
  return inspirationAgent;
}

export function resetInspirationAgent(): void {
  inspirationAgent = null;
}

// ── Prompt ─────────────────────────────────────────

const INSPIRATION_SYSTEM_PROMPT = `你是一位创意无限的网文灵感助手。请基于当前章节内容，从以下方向提供 3-5 个创意建议：

## 灵感方向
- **情节发展** — 下一段情节的可能走向，悬念设置，反转设计
- **人物刻画** — 角色深挖、关系变化、内心冲突
- **冲突设计** — 新增矛盾点、升级冲突、伏笔铺垫
- **环境氛围** — 场景渲染、气氛烘托、意象运用
- **对话设计** — 精彩对话构思、语言风格建议

## 输出格式
请严格按以下 JSON 数组格式输出（不要加 markdown 代码块包裹，直接输出 JSON）：

[
  {
    "title": "建议标题（简短有力）",
    "description": "详细描述建议内容（50-150字），说明为什么这个建议适合当前章节",
    "example": "一段简短的示例文字（30-100字），展示建议的写作效果"
  }
]`;

// ── JSON 解析 ──────────────────────────────────────

function parseInspirationSuggestions(text: string): InspirationSuggestion[] {
  const jsonStr = extractJsonArray(text);

  if (jsonStr === null) {
    return fallbackSuggestions();
  }

  const parseItems = (items: Array<Record<string, unknown>>): InspirationSuggestion[] =>
    items.map((item) => ({
      title: String(item['title'] ?? ''),
      description: String(item['description'] ?? ''),
      example: String(item['example'] ?? ''),
    }));

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parseItems(parsed);
    }
    return fallbackSuggestions();
  } catch {
    // 尝试修复后重试
    try {
      const repaired = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/(?<!\\)'/g, '"')
        .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
      const parsed = JSON.parse(repaired);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parseItems(parsed);
      }
      return fallbackSuggestions();
    } catch {
      return fallbackSuggestions();
    }
  }
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();

  // markdown 代码块
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch !== null) {
    const captured = jsonBlockMatch[1];
    if (captured !== undefined) {
      return captured.trim();
    }
  }

  // 以 [ 开头
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  return null;
}

function fallbackSuggestions(): InspirationSuggestion[] {
  return [
    {
      title: '尝试更多创意',
      description: '灵感建议暂时无法获取，请重试或检查章节内容是否为空。',
      example: '',
    },
  ];
}
