// src/main/infra/novel/writer-agent.ts
// WriterAgent：网文写作 AI Agent，支持续写/扩写/润色/改写
//
// 职责：
// 1. continueWriting — 基于前文和指引生成下文
// 2. expandWriting — 选中段落展开细节（描写/背景/情绪/对话）
// 3. polishWriting — 保持原意优化表达
// 4. rewriteWriting — 按指定风格重写
//
// 所有方法使用 generateText（非流式），返回 WritingResult { content, wordCount }

import { generateText } from 'ai';
import { getModel } from '../ai/ai-provider';
import type {
  ContinueWritingParams,
  ExpandWritingParams,
  PolishWritingParams,
  RewriteWritingParams,
  WritingResult,
} from './types';

/**
 * WriterAgent 接口
 *
 * 定义四种写作操作类型，所有方法返回 WritingResult。
 */
export interface WriterAgentInterface {
  /** 续写：基于前文和指引生成下文 */
  continueWriting(params: ContinueWritingParams): Promise<WritingResult>;
  /** 扩写：选中段落展开细节 */
  expandWriting(params: ExpandWritingParams): Promise<WritingResult>;
  /** 润色：保持原意优化表达 */
  polishWriting(params: PolishWritingParams): Promise<WritingResult>;
  /** 改写：按指定风格重写 */
  rewriteWriting(params: RewriteWritingParams): Promise<WritingResult>;
}

class WriterAgent implements WriterAgentInterface {
  async continueWriting(params: ContinueWritingParams): Promise<WritingResult> {
    const model = await getModel();
    const lengthHint = params.length !== undefined ? `\n预期字数：约 ${params.length} 字。` : '';

    const result = await generateText({
      model,
      system: buildContinueSystemPrompt(params.style),
      prompt: `以下为当前章节的前文内容：\n\n${params.context}\n\n${lengthHint}\n请基于以上内容续写，保持风格和情节连贯，直接输出续写正文，不要加额外说明。`,
    });

    return { content: result.text, wordCount: countWords(result.text) };
  }

  async expandWriting(params: ExpandWritingParams): Promise<WritingResult> {
    const model = await getModel();

    const result = await generateText({
      model,
      system: buildExpandSystemPrompt(params.direction),
      prompt: `请在以下选中段落的基础上展开，丰富细节：\n\n${params.selectedText}\n\n直接输出展开后的正文，不要加额外说明。`,
    });

    return { content: result.text, wordCount: countWords(result.text) };
  }

  async polishWriting(params: PolishWritingParams): Promise<WritingResult> {
    const model = await getModel();

    const result = await generateText({
      model,
      system: '你是一位专业的网文编辑，擅长润色文字。保持原意和风格不变，优化表达流畅度、修正语病、提升可读性。不改变叙事结构和人物设定。',
      prompt: `请润色以下段落：\n\n${params.selectedText}\n\n直接输出润色后的正文，不要加额外说明。`,
    });

    return { content: result.text, wordCount: countWords(result.text) };
  }

  async rewriteWriting(params: RewriteWritingParams): Promise<WritingResult> {
    const model = await getModel();

    const result = await generateText({
      model,
      system: buildRewriteSystemPrompt(params.style),
      prompt: `请按指定风格改写以下段落：\n\n${params.selectedText}\n\n直接输出改写后的正文，不要加额外说明。`,
    });

    return { content: result.text, wordCount: countWords(result.text) };
  }
}

/** WriterAgent 单例 */
let writerAgent: WriterAgent | null = null;

export function getWriterAgent(): WriterAgentInterface {
  if (writerAgent === null) {
    writerAgent = new WriterAgent();
  }
  return writerAgent;
}

export function resetWriterAgent(): void {
  writerAgent = null;
}

// ── Prompt 构建辅助函数 ──────────────────────────────

function buildContinueSystemPrompt(style?: string): string {
  const styleGuide: Record<string, string> = {
    modern: '风格现代、语言简洁明快，贴近当下读者的阅读习惯。',
    classical: '风格偏古典，适当使用文言词汇和句式，注重意境和韵律。',
    light: '轻松向、偏口语化，对话多叙述少，节奏轻快。',
    heavy: '厚重向、描写细腻，注重环境烘托和心理刻画，节奏较慢。',
  };

  const styleDesc = style !== undefined && style in styleGuide ? styleGuide[style] : '';

  return `你是一位资深的网文写作助手。请根据前文内容和风格指引，自然流畅地续写下文。
${styleDesc}
要求：
- 严格遵循前文的叙事视角、人称和时态
- 保持人物性格和行为逻辑一致
- 情节推进自然，避免生硬转折
- 直接输出续写内容，不要加任何解释或说明`;
}

function buildExpandSystemPrompt(direction?: string): string {
  const directionGuide: Record<string, string> = {
    detail: '重点丰富细节描写（环境、外貌、动作、神态），让画面更生动。',
    background: '补充相关背景信息（人物过往、事件起因、世界观设定），增加深度。',
    emotion: '深化情感描写（内心独白、情绪变化、心理活动），增强感染力。',
    dialogue: '扩展对话内容（增加符合人物性格的对话），推动情节或展现人物关系。',
  };

  const directionDesc =
    direction !== undefined && direction in directionGuide
      ? directionGuide[direction]
      : '从多个维度丰富内容（细节、背景、情绪、对话），让段落更丰满。';

  return `你是一位网文写作助手，擅长在保持原有风格的前提下扩展段落。
${directionDesc}
要求：
- 保持原文的叙事视角和语言风格
- 扩展内容需自然融入，不显生硬
- 不改变原有情节走向
- 直接输出展开后的正文`;
}

function buildRewriteSystemPrompt(style: string): string {
  const styleGuide: Record<string, string> = {
    modern: 'modern（现代风）：语言简洁明快，贴近当下读者习惯，少用文言词汇。',
    classical: 'classical（古典风）：适当使用文言词汇和句式，注重意境和韵律感。',
    light: 'light（轻松风）：口语化、轻松诙谐，对话多叙述少，节奏轻快。',
    heavy: 'heavy（厚重风）：描写细腻丰富，注重环境烘托和心理刻画，节奏较慢。',
  };

  const styleDesc = style in styleGuide ? styleGuide[style] : `风格：${style}`;

  return `你是一位风格多变的网文写手，擅长按指定风格改写段落。
目标风格：${styleDesc}
要求：
- 保留核心情节和人物设定不变
- 完全按目标风格重构语言表达
- 保持段落流畅自然
- 直接输出改写后的正文`;
}

// ── 工具函数 ──────────────────────────────────────

/** 估算文本字数（中文字符数 + 英文单词数） */
function countWords(text: string): number {
  const clean = text.trim();
  if (clean.length === 0) return 0;
  const chineseChars = (clean.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const englishText = clean.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ');
  const englishWords = englishText.split(/\s+/).filter(Boolean).length;
  return chineseChars + englishWords;
}
