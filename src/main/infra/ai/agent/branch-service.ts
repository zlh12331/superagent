// src/main/infra/ai/agent/branch-service.ts
// 会话分支：回退（rewind）分支分类与记录（对齐 qwen conversation-branches 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 分支分类纯函数：给定 turn 的父链关系 → ordinary / rewind-descendant / rewind-sibling / mixed-rewind
// - 会话级分支记录（内存，会话运行时结构）
//
// 现状：BranchService 尚无生产调用方（仅单测使用）；会话持久化模型当前为线性
// （schema.ts 的 turns 表无 parent 字段），故本模块是回退能力的预留地基，
// 待会话模型引入 parent 关系时接入。勿据此注释假定已接入回合流程。
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/utils/conversation-branches.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// rewind 分支分类语义，按我们的技术栈收敛重写：
// - 移除 ChatRecord 森林分析（强耦合聊天记录模型，桌面端会话线性 + 回退预留）
// - 保留核心分类：ordinary / rewind-descendant / rewind-sibling / mixed-rewind
// ──────────────────────────────────────────────────────────────

/** 分支分类（四值互斥，判定优先级见 classifyBranch） */
export type BranchClassification =
  | 'ordinary'
  | 'rewind-descendant'
  | 'rewind-sibling'
  | 'mixed-rewind';

/** 分支记录（单次 record 落一条，只读） */
export interface BranchRecord {
  /** 当前 turn id */
  readonly turnId: string;
  /** 父 turn id（回退目标；null = 顺序追加） */
  readonly parentTurnId: string | null;
  /** 分类结果（record 时由 classifyBranch 计算） */
  readonly classification: BranchClassification;
  /** 记录时间（Unix ms） */
  readonly createdAt: number;
}

/** 分类输入（纯函数入参；可选字段缺省即 false） */
export interface BranchClassifyInput {
  /** 当前 turn 的父 turn id（null = 顺序追加） */
  readonly parentTurnId: string | null;
  /** 回退点是否已有其他后继（此前已从该点分叉过） */
  readonly branchPointHasSibling?: boolean;
  /** 本次是否连续多次回退（mixed 判定） */
  readonly multipleRewinds?: boolean;
}

/**
 * 分支分类纯函数（无副作用，可测）
 *
 * 判定优先级（自上而下短路，前一条命中即返回）：
 * 1. multipleRewinds === true → mixed-rewind（最高优先，盖过父子关系）
 * 2. parentTurnId === null → ordinary（顺序追加，无回退）
 * 3. branchPointHasSibling === true → rewind-sibling（回退到已分叉点，产生兄弟分支）
 * 4. 否则 → rewind-descendant（回退到历史点后继续，该点首次分叉）
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
 * 会话分支服务（纯内存记录，无持久化；实例生命周期 = 记录生命周期）
 */
export class BranchService {
  /** sessionId → 分支记录（按 record 调用顺序追加） */
  private readonly branchesBySession = new Map<string, BranchRecord[]>();

  /**
   * 记录一个 turn 的分支关系（自动分类）
   *
   * 兄弟判定基于已记录的历史：仅当同会话内已存在 parentTurnId 相同的记录时才算 sibling
   * （即依赖调用顺序——同一父点第二次及以后回退才判为 rewind-sibling）。
   *
   * @param sessionId 会话 id（隔离维度）
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
   * 列出会话分支记录（按 record 调用顺序；无记录返回空数组）
   */
  list(sessionId: string): BranchRecord[] {
    return this.branchesBySession.get(sessionId) ?? [];
  }

  /**
   * 会话分支摘要：按分支点聚合后代计数
   *
   * 只统计 parentTurnId 非 null 的记录（顺序追加不计入分支点）；
   * 按 count 降序（同 count 时顺序取决于 Map 插入序，无二级排序保证）。
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

  /** 清空会话分支记录（会话删除时；无记录则空操作） */
  clear(sessionId: string): void {
    this.branchesBySession.delete(sessionId);
  }
}
