// src/main/infra/ai/branch-service.ts
// 会话分支：回退（rewind）分支分类与记录（对齐 qwen conversation-branches 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 分支分类纯函数：给定 turn 的父链关系 → ordinary / rewind-descendant / rewind-sibling / mixed-rewind
// - 会话级分支记录（内存，会话运行时结构；持久化随会话模型 parent 字段升级一并落地）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/utils/conversation-branches.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// rewind 分支分类语义，按我们的技术栈收敛重写：
// - 移除 ChatRecord 森林分析（强耦合聊天记录模型，桌面端会话线性 + 回退预留）
// - 保留核心分类：ordinary / rewind-descendant / rewind-sibling / mixed-rewind
// ──────────────────────────────────────────────────────────────

/** 分支分类 */
export type BranchClassification =
  | 'ordinary'
  | 'rewind-descendant'
  | 'rewind-sibling'
  | 'mixed-rewind';

/** 分支记录 */
export interface BranchRecord {
  /** 当前 turn id */
  readonly turnId: string;
  /** 父 turn id（回退目标；null = 顺序追加） */
  readonly parentTurnId: string | null;
  /** 分类结果 */
  readonly classification: BranchClassification;
  /** 记录时间 */
  readonly createdAt: number;
}

/** 分类输入 */
export interface BranchClassifyInput {
  /** 当前 turn 的父 turn id（null = 顺序追加） */
  readonly parentTurnId: string | null;
  /** 回退点是否已有其他后继（此前已从该点分叉过） */
  readonly branchPointHasSibling?: boolean;
  /** 本次是否连续多次回退（mixed 判定） */
  readonly multipleRewinds?: boolean;
}

/**
 * 分支分类纯函数（可测）
 *
 * 语义（对齐 qwen）：
 * - ordinary：无回退（父链顺序）
 * - rewind-descendant：回退到历史点后继续（该点首次分叉）
 * - rewind-sibling：回退到已有其他后继的点（兄弟分支）
 * - mixed-rewind：同一次操作中多次回退
 */
export function classifyBranch(input: BranchClassifyInput): BranchClassification {
  if (input.multipleRewinds === true) {
    return 'mixed-rewind';
  }
  if (input.parentTurnId === null) {
    return 'ordinary';
  }
  return input.branchPointHasSibling === true ? 'rewind-sibling' : 'rewind-descendant';
}

/**
 * 会话分支服务（内存记录）
 */
export class BranchService {
  /** sessionId → 分支记录（按时间顺序） */
  private readonly branchesBySession = new Map<string, BranchRecord[]>();

  /**
   * 记录一个 turn 的分支关系（自动分类）
   *
   * @param sessionId 会话 id
   * @param turnId 当前 turn id
   * @param parentTurnId 父 turn id（回退目标；null = 顺序追加）
   * @returns 分类结果
   */
  record(sessionId: string, turnId: string, parentTurnId: string | null): BranchClassification {
    const records = this.branchesBySession.get(sessionId) ?? [];
    const classification = classifyBranch({
      parentTurnId,
      branchPointHasSibling:
        parentTurnId !== null && records.some((r) => r.parentTurnId === parentTurnId),
    });
    records.push({ turnId, parentTurnId, classification, createdAt: Date.now() });
    this.branchesBySession.set(sessionId, records);
    return classification;
  }

  /**
   * 列出会话分支记录（按记录时间顺序）
   */
  list(sessionId: string): BranchRecord[] {
    return this.branchesBySession.get(sessionId) ?? [];
  }

  /**
   * 会话分支摘要：各分支点 + 后代计数
   */
  summary(sessionId: string): Array<{ parentTurnId: string; count: number }> {
    const records = this.list(sessionId);
    const byParent = new Map<string, number>();
    for (const record of records) {
      if (record.parentTurnId !== null) {
        byParent.set(record.parentTurnId, (byParent.get(record.parentTurnId) ?? 0) + 1);
      }
    }
    return [...byParent.entries()]
      .map(([parentTurnId, count]) => ({ parentTurnId, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 清空会话分支记录（会话删除时） */
  clear(sessionId: string): void {
    this.branchesBySession.delete(sessionId);
  }
}
