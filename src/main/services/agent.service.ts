// src/main/services/agent.service.ts
// 写作 Agent 编排层
// 设计文档 §4.2 agent.service / §5.1 场景 3（AI 流式对话）/ 场景 5（Agent 章节生成）
//
// 职责：
// 1. runChatGeneration：对话流式生成（RAG + 历史 → DeepSeek 流式 → 持久化 assistant 消息）
// 2. generateChapter：续写下一章（前文 + 人物 + RAG → 流式 → 自动建章）
// 3. rewriteChapter：改写章节（原文 + 指令 → 流式 → 自动更新）
// 4. expandOutline：扩写大纲（仅流式返回，不持久化）
//
// 注意：
// - 本模块是设计文档 §4.4 唯一允许编排其他 service 的模块
// - 流式三段式：openai stream → textChunks 提取纯文本 → StreamBridge 推送
// - ackId（UUID）作为 StreamBridge 的流 ID，函数立即返回，生成在后台执行
// - 流异常由 StreamBridge 推 error 事件，本层记 error 用量后吞掉（不 rethrow）

import { randomUUID } from 'node:crypto';
import { IPC_CHANNELS } from '@novel-writer/shared';
import type { WebContents } from 'electron';
import { getAppConfig } from '../config';
import { getOpenAIClient } from '../infra/ai/openai-client';
import { getStreamBridge } from '../infra/ai/stream-bridge';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';
import { logAiUsage } from './ai-usage';
import { createChapter, getChapter, listChapters, updateChapter } from './chapter.service';
import { listCharacters } from './character.service';
import { getChatMessages, saveAssistantMessage } from './chat.service';
import { searchSimilarChunks } from './rag.service';

/** 前文截断长度（取尾部 N 字符，控制 prompt 体积） */
const PREV_CONTENT_TAIL_LENGTH = 2000;

/** 系统 prompt（对话与创作共用基础人设） */
const SYSTEM_PROMPT = `你是一位专业的中文网络小说写作助手。你的职责：
1. 根据用户提供的上下文（章节、人物、世界观、检索片段）进行创作辅助
2. 输出流畅、符合网文风格的中文文本
3. 严格保持与既有设定一致（人物性格、世界观规则）`;

/** openai chat message 项 */
interface ChatMessageItem {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 项目 AI 设置（projectSetting 表 + 默认值兜底） */
interface ResolvedAiSettings {
  aiModel: string;
  aiTemperature: number;
  aiMaxTokens: number;
  ragEnabled: boolean;
  ragTopK: number;
  ragThreshold: number;
}

/** streamChat 入参 */
interface StreamChatInput {
  /** 流 ID（ackId / sessionId） */
  readonly streamId: string;
  readonly webContents: WebContents;
  readonly messages: ChatMessageItem[];
  readonly settings: ResolvedAiSettings;
}

/**
 * 对话流式生成
 *
 * chat:sendMessage 持久化用户消息后，由 IPC handler 调用本函数。
 * 流程：读 session → 读设置 → RAG 检索（失败降级）→ 取历史 → 流式生成 → 持久化 assistant 消息
 */
export async function runChatGeneration(input: {
  sessionId: string;
  webContents: WebContents;
}): Promise<void> {
  const prisma = getPrismaClient();
  const { sessionId, webContents } = input;

  // 1. 校验会话存在（不存在记 warn 直接返回，属异常时序：消息已发但会话被删）
  const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
  if (session === null) {
    logger.warn({ sessionId }, 'runChatGeneration：会话不存在，跳过生成');
    return;
  }

  // 2. 读取项目 AI 设置
  const settings = await resolveAiSettings(session.projectId);

  // 3. 取历史消息
  const history = await getChatMessages(sessionId);
  const lastUserMessage = [...history].reverse().find((m) => m.role === 'user');

  // 4. RAG 检索（失败降级为无 RAG，仅 warn）
  let ragContext = '';
  if (settings.ragEnabled && lastUserMessage !== undefined) {
    try {
      const chunks = await searchSimilarChunks({
        projectId: session.projectId,
        query: lastUserMessage.content,
        topK: settings.ragTopK,
        threshold: settings.ragThreshold,
      });
      if (chunks.length > 0) {
        ragContext = `\n\n# 检索到的相关片段\n${chunks
          .map((c) => `- [相关度 ${c.score.toFixed(2)}] ${c.content}`)
          .join('\n')}`;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'RAG 检索失败，降级为无 RAG 生成',
      );
    }
  }

  // 5. 组装 messages（system 注入 RAG 上下文 + 全部历史）
  const messages: ChatMessageItem[] = [
    { role: 'system', content: SYSTEM_PROMPT + ragContext },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  // 6. 流式生成 + 持久化
  const fullText = await streamChat({ streamId: sessionId, webContents, messages, settings });
  if (fullText.length > 0) {
    await saveAssistantMessage(sessionId, fullText);
  }
}

/**
 * 续写下一章
 *
 * 立即返回 { ackId }，后台流式生成，fullText 非空时自动创建章节。
 */
export async function generateChapter(input: {
  projectId: string;
  prevChapterId?: string;
  prompt?: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  // 后台异步执行（catch 兜底防止未处理 rejection）
  void doGenerateChapter(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'generateChapter 后台执行异常',
    );
  });

  return { ackId };
}

/** generateChapter 后台执行体 */
async function doGenerateChapter(
  ackId: string,
  input: {
    projectId: string;
    prevChapterId?: string;
    prompt?: string;
    webContents: WebContents;
  },
): Promise<void> {
  const settings = await resolveAiSettings(input.projectId);

  // 1. 前文（取尾部 PREV_CONTENT_TAIL_LENGTH 字符）
  let prevSection = '（无前文，从第一章开始）';
  if (input.prevChapterId !== undefined) {
    const prev = await getChapter(input.prevChapterId);
    prevSection = `标题：${prev.title}\n内容（尾部截断）：\n${prev.content.slice(-PREV_CONTENT_TAIL_LENGTH)}`;
  }

  // 2. 人物列表
  const characters = await listCharacters(input.projectId);
  const characterSection =
    characters.length > 0
      ? characters.map((c) => `- ${c.name}（${c.role}）：${c.description ?? '无描述'}`).join('\n')
      : '（暂无人物）';

  // 3. RAG 检索（失败降级）
  let ragSection = '（无检索片段）';
  if (settings.ragEnabled) {
    try {
      const chunks = await searchSimilarChunks({
        projectId: input.projectId,
        query: input.prompt ?? '续写下一章',
        topK: settings.ragTopK,
        threshold: settings.ragThreshold,
      });
      if (chunks.length > 0) {
        ragSection = chunks.map((c) => `- ${c.content}`).join('\n');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RAG 检索失败，降级');
    }
  }

  // 4. 组装 prompt
  const userPrompt = `# 任务：续写下一章

## 前文章节
${prevSection}

## 主要人物
${characterSection}

## 相关检索片段
${ragSection}

## 用户要求
${input.prompt ?? '无额外要求，自由发挥'}

请直接输出章节正文（不要输出标题，不要解释）。`;

  // 5. 流式生成
  const fullText = await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });

  // 6. 自动建章（标题 = 第 N 章，状态 = DRAFT 草稿待人工审阅，追加到末尾）
  if (fullText.length > 0) {
    const existing = await listChapters(input.projectId);
    await createChapter({
      projectId: input.projectId,
      title: `第${existing.length + 1}章`,
      content: fullText,
      status: 'DRAFT',
      sortOrder: existing.length,
    });
    logger.info(
      { ackId, projectId: input.projectId, length: fullText.length },
      'AI 续写章节已创建',
    );
  }
}

/**
 * 改写章节
 *
 * 立即返回 { ackId }，后台流式生成，fullText 非空时自动更新章节内容。
 */
export async function rewriteChapter(input: {
  chapterId: string;
  instruction: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  void doRewriteChapter(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'rewriteChapter 后台执行异常',
    );
  });

  return { ackId };
}

/** rewriteChapter 后台执行体 */
async function doRewriteChapter(
  ackId: string,
  input: { chapterId: string; instruction: string; webContents: WebContents },
): Promise<void> {
  const chapter = await getChapter(input.chapterId);
  const settings = await resolveAiSettings(chapter.projectId);

  const userPrompt = `# 任务：改写章节片段

## 原文
${chapter.content}

## 改写要求
${input.instruction}

请输出改写后的完整正文（不要解释）。`;

  const fullText = await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });

  if (fullText.length > 0) {
    await updateChapter({ id: input.chapterId, content: fullText });
    logger.info({ ackId, chapterId: input.chapterId }, 'AI 改写已更新章节');
  }
}

/**
 * 扩写大纲
 *
 * 立即返回 { ackId }，后台流式生成，结果仅通过流式事件返回（不持久化）。
 */
export async function expandOutline(input: {
  projectId: string;
  outline: string;
  webContents: WebContents;
}): Promise<{ ackId: string }> {
  const ackId = randomUUID();

  void doExpandOutline(ackId, input).catch((err: unknown) => {
    logger.error(
      { ackId, err: err instanceof Error ? err.message : String(err) },
      'expandOutline 后台执行异常',
    );
  });

  return { ackId };
}

/** expandOutline 后台执行体 */
async function doExpandOutline(
  ackId: string,
  input: { projectId: string; outline: string; webContents: WebContents },
): Promise<void> {
  const settings = await resolveAiSettings(input.projectId);

  const userPrompt = `# 任务：扩写大纲

## 原始大纲
${input.outline}

请扩写为详细分章大纲（每章 3-5 个要点）。`;

  await streamChat({
    streamId: ackId,
    webContents: input.webContents,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    settings,
  });
}

/**
 * 流式生成核心（4 个公共函数共用）
 *
 * 流程：openai 流式创建 → textChunks 提取纯文本 → StreamBridge 推送 → 用量记录
 *
 * @returns 完整生成文本（被 abort 时返回已生成的部分文本）
 *
 * 异常处理：openai 调用或流迭代异常时，StreamBridge 已推 error 事件，
 * 本函数记 error 用量后返回空字符串（不 rethrow —— 渲染层已通过 error 事件感知）
 */
async function streamChat(input: StreamChatInput): Promise<string> {
  const { streamId, webContents, messages, settings } = input;
  const start = Date.now();

  try {
    const client = await getOpenAIClient();
    const stream = await client.chat.completions.create({
      model: settings.aiModel,
      messages,
      temperature: settings.aiTemperature,
      // biome-ignore lint/style/useNamingConvention: max_tokens 是 openai SDK 官方字段名
      max_tokens: settings.aiMaxTokens,
      stream: true,
    });

    const fullText = await getStreamBridge().streamToWebContents({
      sessionId: streamId,
      webContents,
      stream: textChunks(stream),
      chunkChannel: IPC_CHANNELS.CHAT_STREAM_CHUNK,
      endChannel: IPC_CHANNELS.CHAT_STREAM_END,
      errorChannel: IPC_CHANNELS.CHAT_STREAM_ERROR,
    });

    void logAiUsage({
      provider: 'deepseek',
      model: settings.aiModel,
      inputTokens: messages.reduce((sum, m) => sum + m.content.length, 0),
      outputTokens: fullText.length,
      durationMs: Date.now() - start,
      status: 'ok',
    });

    return fullText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void logAiUsage({
      provider: 'deepseek',
      model: settings.aiModel,
      durationMs: Date.now() - start,
      status: 'error',
      error: message,
    });
    logger.error({ streamId, err: message }, '流式生成失败');
    return '';
  }
}

/**
 * openai 流 → 纯文本 chunk 提取
 *
 * stream-bridge 的 chunkToString 对对象会 JSON.stringify，
 * 因此必须先把 openai chunk 映射为纯文本 delta，否则渲染层收到的是 JSON 字符串。
 */
async function* textChunks(
  stream: AsyncIterable<{
    choices?: { delta?: { content?: string | null } | null }[];
  }>,
): AsyncGenerator<string> {
  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      yield content;
    }
  }
}

/**
 * 读取项目 AI 设置（无记录时用 Prisma schema 默认值兜底）
 */
async function resolveAiSettings(projectId: string): Promise<ResolvedAiSettings> {
  const prisma = getPrismaClient();
  const found = await prisma.projectSetting.findUnique({ where: { projectId } });

  if (found === null) {
    const config = getAppConfig();
    return {
      aiModel: config.deepseek.model,
      aiTemperature: 0.7,
      aiMaxTokens: 4096,
      ragEnabled: true,
      ragTopK: 5,
      ragThreshold: 0.7,
    };
  }

  return {
    aiModel: found.aiModel,
    aiTemperature: found.aiTemperature,
    aiMaxTokens: found.aiMaxTokens,
    ragEnabled: found.ragEnabled,
    ragTopK: found.ragTopK,
    ragThreshold: found.ragThreshold,
  };
}
