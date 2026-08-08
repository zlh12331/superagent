// packages/shared/src/schemas/agent-ask.ts
// Agent 交互式提问契约（ask_user_question 工具 → 渲染层提问 UI）
// ──────────────────────────────────────────────────────────────
// 设计（对齐 qwen-code askUserQuestion 工具 + 本项目审批闭环模式）：
// - 主进程工具执行时经 webContents.send 推送 AGENT_ASK_REQUEST 事件
// - 渲染层弹出提问对话框，用户选择/输入后 invoke agent:ask:respond 回传
// - 工具 await 回答后作为 ToolResult 返回给 LLM（继续执行）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 问题选项（单选/多选场景） */
export const AgentQuestionOptionSchema = z.object({
  /** 选项标签（展示给用户） */
  label: z.string().min(1),
  /** 选项说明（补充描述） */
  description: z.string().optional(),
});

/** Agent 向用户提出的问题 */
export const AgentQuestionSchema = z.object({
  /** 问题正文 */
  question: z.string().min(1),
  /** 问题标题（分组展示，如「代码审查」） */
  header: z.string().optional(),
  /** 预置选项（用户可点选，也可忽略直接输入文本） */
  options: z.array(AgentQuestionOptionSchema).optional(),
  /** 是否多选（默认单选） */
  multiSelect: z.boolean().optional(),
});

/** 提问请求（ask_user_question 工具入参：支持一次多问） */
export const AskUserQuestionReqSchema = z.object({
  questions: z.array(AgentQuestionSchema).min(1),
});

/** 单问题回答 */
export const AgentAnswerSchema = z.object({
  /** 选中的选项索引（多选为数组；未选为空） */
  selectedIndexes: z.array(z.number().int().min(0)).optional(),
  /** 用户输入的文本（选项之外的自由回答；空字符串 = 仅选项） */
  text: z.string().optional(),
});

/** 回答回传请求（渲染层 → 主进程） */
export const AskRespondReqSchema = z.object({
  /** 提问 id（主进程生成，关联 pending） */
  askId: z.string(),
  /** 每个问题的回答（与 questions 一一对应） */
  answers: z.array(AgentAnswerSchema),
});

/** 回答回传响应（ack） */
export const AskRespondResSchema = z.object({
  ok: z.boolean(),
});

/** 提问事件 payload（主进程 agent:event:ask 推送） */
export const AskEventPayloadSchema = z.object({
  /** 提问 id（渲染层回传时原样带回） */
  askId: z.string(),
  /** 问题列表 */
  questions: z.array(AgentQuestionSchema),
});

/** 问题选项类型 */
export type AgentQuestionOption = z.infer<typeof AgentQuestionOptionSchema>;
/** Agent 问题类型 */
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;
/** 提问请求类型 */
export type AskUserQuestionReq = z.infer<typeof AskUserQuestionReqSchema>;
/** 回答回传请求类型 */
export type AskRespondReq = z.infer<typeof AskRespondReqSchema>;
/** 回答回传响应类型 */
export type AskRespondRes = z.infer<typeof AskRespondResSchema>;
/** 单问题回答类型 */
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;
/** 提问事件 payload 类型 */
export type AskEventPayload = z.infer<typeof AskEventPayloadSchema>;
