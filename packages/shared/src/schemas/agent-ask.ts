// agent-ask.ts：Agent 交互式提问的跨进程契约（提问下发 / 作答回传 / 决议事件）
// 链路：ask_user_question 工具经 agent:event:ask 推送提问 → 渲染层弹窗作答 → invoke agent:ask:respond
// 回传 → 工具 await 回答继续回合。
// 边界：只定义 schema 与类型；pending 闭环（src/main/infra/ai/agent/agent-ask-service.ts）与弹窗 UI 在别处。

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

/**
 * 提问请求（ask_user_question 工具入参：支持一次多问）
 *
 * 工具侧为 LLM 生成另存了一份带 .describe 提示的本地 schema 副本
 * （src/main/infra/ai/tools/ask-user-question.tool.ts）——改字段要两处同步。
 */
export const AskUserQuestionReqSchema = z.object({
  questions: z.array(AgentQuestionSchema).min(1),
});

/** 单问题回答 */
export const AgentAnswerSchema = z.object({
  /** 选中的选项索引（指向所属问题 options 的下标；多选为数组，未选为空/缺省） */
  selectedIndexes: z.array(z.number().int().min(0)).optional(),
  /** 用户输入的文本（选项之外的自由回答；空字符串 = 仅选项） */
  text: z.string().optional(),
});

/** 回答回传请求（渲染层 → 主进程） */
export const AskRespondReqSchema = z.object({
  /** 提问 id（主进程生成，关联 pending） */
  askId: z.string(),
  /** 每个问题的回答（顺序与数量需与 questions 对齐，工具按下标取用） */
  answers: z.array(AgentAnswerSchema),
});

/** 回答回传响应（ack） */
export const AskRespondResSchema = z.object({
  /** 是否命中 pending（false = 提问已超时/已作答/已清理，回传被无害丢弃） */
  ok: z.boolean(),
});

/** 提问事件 payload（主进程 agent:event:ask 推送） */
export const AskEventPayloadSchema = z.object({
  /** 发起提问的会话 id（多会话并发时按会话归属弹窗与清理） */
  sessionId: z.string().min(1),
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

// ───── 决议事件（提问终态：作答 / 超时 / 中断清理） ─────

/**
 * 提问决议事件 payload（主进程 → 渲染层）
 *
 * 与 agent:event:ask 配对：任一提问最终都会走到一个决议（用户作答、超时、
 * 中断清理），渲染层据此把该提问移出队列——否则超时等非用户路径会让弹窗
 * 永久残留，且队列化后已超时的队头会阻塞后续提问。
 *
 * decision 取值语义与主进程 AskDecisionOutcome
 * （src/main/infra/ai/agent/agent-ask-service.ts）对齐。
 */
export interface AskResolvedPayload {
  /** 归属会话 id */
  readonly sessionId: string;
  /** 决议对应的提问 id（渲染层据此定位待答条目） */
  readonly askId: string;
  /**
   * 决议结果：
   * - 'answered'   用户作答
   * - 'timed-out'  提问超时（回合状态机 after 转换 → expireAsk，工具按「未响应」继续）
   * - 'aborted'    回合中断导致 pending 被 dispose 清理；当前无生产者（保留该值是为与审批决议枚举对称）
   */
  readonly decision: 'answered' | 'timed-out' | 'aborted';
}

/** 提问决议事件 payload zod schema（主进程发送侧 dev 契约校验用） */
export const AskResolvedPayloadSchema = z.object({
  sessionId: z.string().min(1),
  askId: z.string().min(1),
  decision: z.enum(['answered', 'timed-out', 'aborted']),
});
