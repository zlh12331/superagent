// src/renderer/hooks/use-agent.ts
// Agent 写作领域 hooks + 流式订阅
// 设计文档 §5.1 场景 5（Agent 章节生成）+ §7.7 Agent 编排
//
// 职责：
// - useGenerateChapter：续写下一章（注册流 + 流式完成后失效章节列表缓存）
// - useRewriteChapter：改写章节（注册流 + 流式完成后失效章节详情缓存）
// - useExpandOutline：扩写大纲（结果仅流式展示，不持久化）
// - useAgentStreamSubscription：订阅 chat:stream:* 事件，按 ackId 过滤后写入 agent-stream.store
//
// 注意：
// - Agent 后端复用 chat 流式 channel（chat:stream:chunk/end/error），
//   payload.sessionId 实际值是 ackId（见 src/main/services/agent.service.ts streamId: ackId）
// - 故本 hook 订阅时需用 ackId 过滤 payload.sessionId，避免与对话流式串扰
// - mutation onSuccess 不等流式完成（流式在后台异步进行），仅注册流并返回 ackId
// - 真正的"完成副作用"（失效缓存）由调用方在监听到 statusByAckId[ackId] === 'completed'
//   时触发（见 useAgentCompletionEffect）

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';
import type { AgentStreamStatus, AgentTaskKind } from '@/stores/agent-stream.store';
import { useAgentStreamStore } from '@/stores/agent-stream.store';

/**
 * 续写下一章
 *
 * 调用 agent:generateChapter，立即返回 { ackId }，后台流式生成。
 * 成功后注册流到 store（kind='generate', targetId=projectId），
 * 流式完成后的失效缓存由 useAgentCompletionEffect 处理。
 *
 * @example
 * const { mutateAsync, isPending } = useGenerateChapter();
 * const { ackId } = await mutateAsync({ projectId, prevChapterId, prompt });
 */
export function useGenerateChapter() {
  const registerStream = useAgentStreamStore((s) => s.registerStream);
  return useMutation({
    mutationFn: async (input: { projectId: string; prevChapterId?: string; prompt?: string }) =>
      unwrap<{ ackId: string }>(await apiClient.agent.generateChapter(input)),
    onSuccess: (data, vars) => {
      registerStream(data.ackId, 'generate' satisfies AgentTaskKind, vars.projectId);
    },
  });
}

/**
 * 改写章节
 *
 * 调用 agent:rewrite，立即返回 { ackId }，后台流式生成。
 * 成功后注册流到 store（kind='rewrite', targetId=chapterId），
 * 流式完成后的失效缓存由 useAgentCompletionEffect 处理。
 *
 * @example
 * const { mutateAsync, isPending } = useRewriteChapter();
 * const { ackId } = await mutateAsync({ chapterId, instruction });
 */
export function useRewriteChapter() {
  const registerStream = useAgentStreamStore((s) => s.registerStream);
  return useMutation({
    mutationFn: async (input: { chapterId: string; instruction: string }) =>
      unwrap<{ ackId: string }>(await apiClient.agent.rewrite(input)),
    onSuccess: (data, vars) => {
      registerStream(data.ackId, 'rewrite' satisfies AgentTaskKind, vars.chapterId);
    },
  });
}

/**
 * 扩写大纲
 *
 * 调用 agent:expandOutline，立即返回 { ackId }，后台流式生成。
 * 结果仅通过流式事件返回（后端不持久化），UI 层订阅展示。
 *
 * @example
 * const { mutateAsync, isPending } = useExpandOutline();
 * const { ackId } = await mutateAsync({ projectId, outline });
 */
export function useExpandOutline() {
  const registerStream = useAgentStreamStore((s) => s.registerStream);
  return useMutation({
    mutationFn: async (input: { projectId: string; outline: string }) =>
      unwrap<{ ackId: string }>(await apiClient.agent.expandOutline(input)),
    onSuccess: (data, vars) => {
      registerStream(data.ackId, 'expand' satisfies AgentTaskKind, vars.projectId);
    },
  });
}

/**
 * 订阅 Agent 流式事件
 *
 * 在组件 mount 时订阅 chat:stream:chunk/end/error（Agent 复用 chat 流式 channel），
 * 按 ackId 过滤后写入 agent-stream.store。
 *
 * 设计要点：
 * - Agent 与对话共用同一组 stream channel，需通过 ackId 过滤
 * - 传入的 ackId 是当前组件关心的活跃流，其他 ackId 被忽略
 * - unmount 时自动 cleanup 订阅
 *
 * @param ackId - 当前关心的 ackId（null 时不订阅）
 */
export function useAgentStreamSubscription(ackId: string | null): void {
  const appendChunk = useAgentStreamStore((s) => s.appendChunk);
  const endStream = useAgentStreamStore((s) => s.endStream);
  const errorStream = useAgentStreamStore((s) => s.errorStream);

  useEffect(() => {
    if (ackId === null) {
      return;
    }

    // 订阅三类流式事件，按 ackId 过滤
    // 注意：payload.sessionId 实际是 ackId（Agent 后端复用 chat channel）
    const unsubChunk = apiClient.chat.onStreamChunk((payload) => {
      if (payload.sessionId === ackId) {
        appendChunk(payload.sessionId, payload.chunk);
      }
    });
    const unsubEnd = apiClient.chat.onStreamEnd((payload) => {
      if (payload.sessionId === ackId) {
        endStream(payload.sessionId, payload.fullText);
      }
    });
    const unsubError = apiClient.chat.onStreamError((payload) => {
      if (payload.sessionId === ackId) {
        const message =
          payload.error instanceof Error ? payload.error.message : String(payload.error);
        errorStream(payload.sessionId, message);
      }
    });

    return () => {
      unsubChunk();
      unsubEnd();
      unsubError();
    };
  }, [ackId, appendChunk, endStream, errorStream]);
}

/**
 * 监听 Agent 流式完成并触发副作用（失效缓存）
 *
 * 当指定 ackId 的流式状态从 streaming 转为 completed 时：
 * - generate：失效该项目下章节列表缓存（让新建章节自动出现）
 * - rewrite：失效该章节详情缓存（让改写后的内容同步到编辑器）
 * - expand：无缓存副作用（仅 UI 展示）
 *
 * 当状态转为 error 时：由调用方自行处理错误展示，本 hook 不做副作用。
 *
 * @example
 * useAgentCompletionEffect(activeAckId);
 */
export function useAgentCompletionEffect(ackId: string | null): void {
  const qc = useQueryClient();
  // 用 ref 保存上一个 status，用于检测 streaming → completed 转换
  const prevStatusRef = useRef<AgentStreamStatus>('completed');

  // selector 订阅当前 ackId 的状态
  const status = useAgentStreamStore((s) =>
    ackId
      ? (s.statusByAckId[ackId] ?? ('completed' as AgentStreamStatus))
      : ('completed' as AgentStreamStatus),
  );
  const kind = useAgentStreamStore((s) => (ackId ? s.kindByAckId[ackId] : null));
  const targetId = useAgentStreamStore((s) => (ackId ? s.targetIdByAckId[ackId] : null));

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    // 仅在 streaming → completed 转换时触发失效缓存
    if (prev !== 'streaming' || status !== 'completed') {
      return;
    }
    // selector 已保证 ackId 为 null 时 status 永远是 'completed' 兜底，
    // 不会进入此分支；此处二次校验防御
    if (ackId === null) {
      return;
    }

    // 按任务类型失效对应缓存
    // kind/targetId 同样依赖 ackId 非空，但 TS 无法跨变量收窄
    // 故用 typeof 进一步检查
    if (kind === 'generate' && typeof targetId === 'string') {
      // generate 的 targetId 是 projectId，失效章节列表
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.list(targetId) });
    } else if (kind === 'rewrite' && typeof targetId === 'string') {
      // rewrite 的 targetId 是 chapterId，失效章节详情
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.detail(targetId) });
    }
    // expand 不持久化，无需失效缓存
  }, [status, kind, targetId, ackId, qc]);
}
