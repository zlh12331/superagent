// src/renderer/stores/transient/approvals-store.ts
// 审批门状态管理（L2 客户端共享状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护待审批队列（FIFO，主进程推送 approval 事件时入队）
// - 提供 approve / reject / 取消 原子操作，回写主进程
// - 单个会话可有多个待审批项（如批量文件编辑）
//
// 设计：
// - 纯状态容器，不调用 IPC（业务 hook 监听队列变化后副作用执行）
// - 决议后移入 resolved 列表（最多 20 条，内联卡回显最近一条；× 按钮 dismiss 移除），无自动出队
// - 不持久化：审批决策是即时操作，跨重启保留意义不大
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/**
 * 审批类型枚举
 *
 * 对照原型 prototype-v2.html 的 7 种审批卡：
 * - run_command：执行 shell 命令
 * - write_file：写入新文件
 * - edit_file：编辑已有文件
 * - delete_file：删除文件
 * - apply_patch：应用 diff 补丁
 * - install_package：安装 npm 包
 * - external_call：外部 API 调用（MCP / webhook）
 *
 * Git 写操作（影响仓库状态 / 远程仓库）：
 * - git_add：暂存工作区改动（git add）
 * - git_commit：提交暂存区改动到本地仓库（git commit）
 * - git_push：推送本地提交到远程仓库（git push，影响他人）
 */
export type ApprovalType =
  | 'run_command'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'apply_patch'
  | 'install_package'
  | 'external_call'
  | 'git_add'
  | 'git_commit'
  | 'git_push';

/**
 * 审批状态
 *
 * - pending：等待用户决策
 * - approved：用户批准（已通知主进程执行）
 * - rejected：用户拒绝（已通知主进程取消）
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * 审批项
 */
export interface ApprovalItem {
  /** 审批 id（由主进程生成，贯穿整个审批生命周期） */
  readonly id: string;
  /** 所属会话 id */
  readonly sessionId: string;
  /** 审批类型（决定 UI 卡片样式与展示字段） */
  readonly type: ApprovalType;
  /** 审批状态 */
  readonly status: ApprovalStatus;
  /** 标题（如 "执行命令: npm install"） */
  readonly title: string;
  /** 详细描述（命令内容、文件路径、diff 内容等） */
  readonly description: string;
  /**
   * 工具原始入参（由主进程透传，结构由工具决定）
   *
   * 用于 UI 结构化展示：
   * - run_command: { command, cwd?, timeout }
   * - write_file: { path, content, append, createDirs }
   * - edit_file: { path, oldString, newString, replaceAll }
   *
   * 类型为 unknown 以避免渲染层依赖主进程的工具入参类型。
   */
  readonly input: unknown;
  /** 创建时间戳（ms） */
  readonly createdAt: number;
  /** 决议时间戳（ms，pending 时为 null） */
  readonly resolvedAt: number | null;
}

/**
 * 审批状态形状
 */
interface ApprovalsState {
  /** 待审批队列（按 createdAt 升序，先入先审） */
  readonly pending: ApprovalItem[];
  /** 最近已决议的审批（用于 UI 反馈，最多保留 20 条） */
  readonly resolved: ApprovalItem[];

  // ── 操作方法 ────────────────────────────────────────
  /** 入队新审批（主进程推送 approval 事件时调用） */
  readonly enqueue: (item: Omit<ApprovalItem, 'status' | 'resolvedAt'>) => void;
  /** 批准审批项 */
  readonly approve: (id: string) => void;
  /** 拒绝审批项 */
  readonly reject: (id: string) => void;
  /** 从已决议列表移除（UI 反馈完成后调用） */
  readonly dismiss: (id: string) => void;
  /** 清空指定会话的所有待审批（会话被中断时调用） */
  readonly clearBySession: (sessionId: string) => void;
}

/** 已决议列表最大保留条数 */
const MAX_RESOLVED = 20;

/**
 * 审批状态 store
 *
 * @example
 * ```tsx
 * const pending = useApprovalsStore((s) => s.pending);
 * const approve = useApprovalsStore((s) => s.approve);
 * ```
 */
export const useApprovalsStore = create<ApprovalsState>()((set) => ({
  pending: [],
  resolved: [],

  enqueue: (item) =>
    set((state) => ({
      pending: [
        ...state.pending,
        {
          ...item,
          status: 'pending' as const,
          resolvedAt: null,
        },
      ],
    })),

  approve: (id) =>
    set((state) => {
      const item = state.pending.find((a) => a.id === id);
      if (item === undefined) {
        return state;
      }
      const resolved: ApprovalItem = {
        ...item,
        status: 'approved',
        resolvedAt: Date.now(),
      };
      return {
        pending: state.pending.filter((a) => a.id !== id),
        resolved: [resolved, ...state.resolved].slice(0, MAX_RESOLVED),
      };
    }),

  reject: (id) =>
    set((state) => {
      const item = state.pending.find((a) => a.id === id);
      if (item === undefined) {
        return state;
      }
      const resolved: ApprovalItem = {
        ...item,
        status: 'rejected',
        resolvedAt: Date.now(),
      };
      return {
        pending: state.pending.filter((a) => a.id !== id),
        resolved: [resolved, ...state.resolved].slice(0, MAX_RESOLVED),
      };
    }),

  dismiss: (id) =>
    set((state) => ({
      resolved: state.resolved.filter((a) => a.id !== id),
    })),

  clearBySession: (sessionId) =>
    set((state) => ({
      pending: state.pending.filter((a) => a.sessionId !== sessionId),
    })),
}));
