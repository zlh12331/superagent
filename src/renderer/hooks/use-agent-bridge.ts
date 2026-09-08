// src/renderer/hooks/use-agent-bridge.ts
// Agent 生命周期 IPC 桥接 Hook（回合结束的统一消费端）
// ──────────────────────────────────────────────────────────────
// 职责（对齐参考设计的状态分层原则）：
// 1. 回合结束（stream:end）→ invalidate 会话列表 + 详情缓存（L3 模式 B）
//    - 修正"回合结束但会话详情缓存仍是旧数据"的正确性问题
// 2. 回合结束 → 清理 L2 流式缓冲（tool-store / approvals-store clearBySession）
//    - 对齐"turn_done 清空流式缓冲"原则，防止长会话内存累积
// 3. 回合结束 → 失效用量汇总缓存（['usage'] 前缀；真实 UI 读 SQLite 聚合）
//    - 孤儿 usage-store 已移除（2026-08 P2 清理）
//
// 设计：
// - 在 AppShell 根布局初始化一次（与 useToolBridge 相同的桥接模式）
// - 全局订阅（不按 sessionId 过滤）：任何会话回合结束都触发统一处理
// - 不处理 UI 展示（由 ChatPanel 等组件订阅 store 渲染）
// ──────────────────────────────────────────────────────────────

import type { AgentStreamEndPayload, AgentStreamErrorPayload } from '@code-agent/shared/renderer';
import { useEffect } from 'react';

import { SESSION_DETAIL_QUERY_KEY, SESSIONS_QUERY_KEY } from '@/hooks/use-sessions';
import { queryClient } from '@/lib/query/query-client';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';
import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { useRateLimitStore } from '@/stores/transient/rate-limit-store';

/**
 * Agent 回合结束统一处理（invalidate 缓存 + 清理 L2 缓冲）
 */
function handleSessionEnd(sessionId: string): void {
  // 1. L3 模式 B：失效会话列表 + 详情缓存（回合结束后重新拉取）
  void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  if (sessionId.length > 0) {
    // 详情缓存必须失效（2026-09-08 评估后保留）：ChatPanel 用 useSessionDetail
    // 的 initialMessages 初始化 useChat（reconstructHistory），若此处不失效，
    // 用户切走再切回该会话会看到回合前的旧消息。一次全量重拉换来的是
    // 「重开会话数据正确」，该代价可接受（数据层全量传输债见技术债清单，
    // 应由 session:get 分页/增量解决，而非在失效点绕过）。
    void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(sessionId) });
    // 目标判定在回合结束后执行（GoalService TURN_END → 可能 completed）——失效目标列表缓存
    void queryClient.invalidateQueries({ queryKey: ['goal', 'list', sessionId] });
    // P3 修复：task 列表此前遗漏失效——回合内新增/更新的 task 在回合结束后
    // 30s（staleTime）内右面板 InfoPane 仍显示旧状态，而回合结束恰是
    // 最需要看任务收敛的时刻。前缀匹配覆盖 ['task', 'list', sessionId] 等子 key。
    void queryClient.invalidateQueries({ queryKey: ['task'] });
    // P2 修复：用量汇总此前无人失效——设置页 usage-section 读 SQLite
    // session:getUsageSummary（queryKey ['usage','summary']），回合结束
    // 不失效则展示过期数据。前缀匹配覆盖 summary 及其派生 key。
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
    // 2026-09-08 修复：回合内 git/file/turns 的写入此前无人失效——
    // Agent 通过 git_add/git_commit 改动工作区后 GitPanel（staleTime 10s）不刷新；
    // write_file/edit_file 落盘后已打开的文件面板（staleTime 30s）显示旧内容；
    // 设置页回合记录（['turns','recent']）从定义起无任何失效点，永远等 gc。
    // 前缀匹配：['git',...] / ['file',...] / ['turns',...]。
    void queryClient.invalidateQueries({ queryKey: ['git'] });
    void queryClient.invalidateQueries({ queryKey: ['file'] });
    void queryClient.invalidateQueries({ queryKey: ['turns'] });
  }

  // 2. L2 清理：审批缓冲 + 提问弹窗（对齐 turn_done 清空原则）
  //    P3 修复：tool-store 不再随回合结束清空——右面板 DiffPane/InfoPane 的
  //    「本轮文件变更/引用文件」数据源正是 callsBySession，回合结束瞬间清空
  //    会让用户恰在回合后想回看变更时无数据。内存上限由 tool-store 的
  //    MAX_CALLS_PER_SESSION 环形淘汰保证（会话切换时按 sessionId 过滤，无串扰）
  useApprovalsStore.getState().clearBySession(sessionId);
  // P2 修复：agent-ask-store 此前遗漏——ask_user_question 弹窗是全屏模态，
  // 主进程 60s 超时后回合继续至 end/error，但渲染层 askId 不清则弹窗持续
  // 遮挡整个界面（此时提交只会收到"未匹配 pending"错误 toast）。
  // 按会话精确清理：并发回合时 A 会话结束不清 B 会话的提问弹窗
  useAgentAskStore.getState().clearAsk(sessionId);

  // 3. usage 累积已移除：原 usage-store 是无人消费的孤儿 store（仅本桥接写入），
  //    真实用量 UI 读 SQLite session:getUsageSummary，失效已在上方统一处理
}

/**
 * Agent 生命周期 IPC 桥接 Hook
 *
 * 在根布局（AppShell）调用一次。
 *
 * @example
 * ```tsx
 * function AppShell() {
 *   useAgentBridge();
 *   // ...
 * }
 * ```
 */
export function useAgentBridge(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) return;

    // 回合正常结束 / 用户中断：invalidate 缓存 + 清理缓冲 + usage 累积
    const unsubscribeEnd = window.api.agent.subscribeStreamEnd((payload) => {
      const typedPayload = payload as AgentStreamEndPayload;
      handleSessionEnd(typedPayload.sessionId);
    });

    // 回合异常结束：同样 invalidate + 清理（错误可能已部分落库）
    const unsubscribeError = window.api.agent.subscribeStreamError((payload) => {
      const typedPayload = payload as AgentStreamErrorPayload;
      handleSessionEnd(typedPayload.sessionId);
      // 429 限流：触发限流横幅（RateLimitBanner 订阅显示）
      if (typedPayload.code === 'AI_RATE_LIMITED') {
        useRateLimitStore.getState().trigger();
      }
    });

    return () => {
      unsubscribeEnd();
      unsubscribeError();
    };
  }, []);
}
