// src/renderer/stores/transient/terminal-store.ts
// 终端实例状态管理（L2 客户端共享状态层 - transient）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护多个终端 tab 的元数据（每个会话对应一个独立 PTY 终端）
// - 提供创建 / 切换 / 关闭终端的原子操作
// - 缓存最近输出片段，支持组件卸载重挂后恢复可见内容
//
// 设计：
// - 纯状态容器：仅维护元数据 + 输出缓冲，不持有 xterm.js Terminal 实例
//   （Terminal 实例由 TerminalPanel 组件 ref 持有，避免序列化与跨 store 引用）
// - PTY 进程由主进程 node-pty 创建，本 store 仅记录 pid 用于 IPC 路由
// - 输出缓冲采用环形截断（MAX_BUFFER_LINES），避免内存膨胀
// - 不做持久化：终端会话随主进程退出即销毁，重启后为空
// ──────────────────────────────────────────────────────────────

import { create } from 'zustand';

/**
 * 单个终端的元数据
 *
 * 不含 xterm.js Terminal 实例（实例由组件持有，避免进入 store）。
 */
export interface TerminalMeta {
  /** 终端 id（与主进程 PTY 会话 id 对齐） */
  readonly id: string;
  /** 关联的 Agent 会话 id（同一会话内可复用终端） */
  readonly sessionId: string;
  /** 终端标题（用于 tab 显示，默认 `bash` / `pwsh`） */
  readonly title: string;
  /** 主进程 PTY 进程 pid（用于 IPC 路由输入与 resize） */
  readonly pid: number | null;
  /** 工作目录（初始 cwd） */
  readonly cwd: string;
  /** 是否存活（pty exit 后置 false，UI 显示为已结束） */
  readonly alive: boolean;
  /** 创建时间戳（ms） */
  readonly createdAt: number;
}

/**
 * 终端状态形状
 */
interface TerminalState {
  /** 终端列表（按 createdAt 升序，先创建的在前） */
  readonly terminals: TerminalMeta[];
  /** 当前激活的终端 id（无激活终端时为 null） */
  readonly activeTerminalId: string | null;
  /**
   * 输出缓冲：terminalId -> 原始 ANSI 字符串（字节级环形截断）
   *
   * P3 修复：此前按「行」切分存储，ANSI 转义序列被拦腰截断，
   * 兜底恢复（卸载重挂）时输出损坏。现改为原样累积，仅按字节上限截断。
   */
  readonly buffers: ReadonlyMap<string, string>;

  // ── 操作方法 ────────────────────────────────────────
  /** 创建新终端并设为激活 */
  readonly createTerminal: (meta: Omit<TerminalMeta, 'createdAt'>) => string;
  /** 切换激活终端 */
  readonly setActiveTerminal: (id: string) => void;
  /** 关闭终端（同时清理缓冲） */
  readonly closeTerminal: (id: string) => void;
  /** 标记终端 exit（pty 退出后调用，UI 显示已结束状态） */
  readonly markExited: (id: string) => void;
  /** 追加原始输出片段（原样累积，环形截断到 MAX_BUFFER_BYTES 字节） */
  readonly appendOutput: (id: string, data: string) => void;
  /** 清空指定终端的输出缓冲 */
  readonly clearBuffer: (id: string) => void;
}

/** 单个终端输出缓冲最大字节数（环形截断，避免内存膨胀；与主进程 MAX_BUFFER_BYTES 对齐） */
const MAX_BUFFER_BYTES = 100 * 1024;

/**
 * 终端状态 store
 *
 * 不持久化：终端会话随主进程退出即销毁。
 *
 * @example
 * ```tsx
 * const terminals = useTerminalStore((s) => s.terminals);
 * const activeId = useTerminalStore((s) => s.activeTerminalId);
 * const create = useTerminalStore((s) => s.createTerminal);
 * ```
 */
export const useTerminalStore = create<TerminalState>()((set) => ({
  terminals: [],
  activeTerminalId: null,
  buffers: new Map<string, string>(),

  createTerminal: (meta) => {
    const id = meta.id;
    const terminal: TerminalMeta = {
      ...meta,
      createdAt: Date.now(),
    };
    set((state) => {
      // 去重：StrictMode 双执行 effect 可能对同一 id 重复写入（实测 2 个 bash 标签 + same key 错误）
      if (state.terminals.some((t) => t.id === id)) {
        return state;
      }
      return {
        terminals: [...state.terminals, terminal],
        activeTerminalId: id,
      };
    });
    return id;
  },

  setActiveTerminal: (id) =>
    set(() => ({
      activeTerminalId: id,
    })),

  closeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id);
      const activeTerminalId =
        state.activeTerminalId === id ? (terminals.at(-1)?.id ?? null) : state.activeTerminalId;
      // 清理对应输出缓冲
      const buffers = new Map(state.buffers);
      buffers.delete(id);
      return { terminals, activeTerminalId, buffers };
    }),

  markExited: (id) =>
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, alive: false } : t)),
    })),

  appendOutput: (id, data) =>
    set((state) => {
      // P3 修复：原始 ANSI 字符串原样累积（不切行，转义序列保持完整），
      // 超过 MAX_BUFFER_BYTES 时按字节保留尾部（与主进程环形截断策略一致）
      if (data.length === 0) {
        return state;
      }
      const existing = state.buffers.get(id) ?? '';
      const combined = existing + data;
      let truncated = combined;
      // 渲染层无 Node Buffer：用 TextEncoder/TextDecoder 做字节级截断
      // （与主进程 Buffer 环形截断策略一致；截断点可能切开多字节字符，
      // 产生单个替换符，与主进程行为对齐，可接受）
      const bytes = new TextEncoder().encode(combined);
      if (bytes.byteLength > MAX_BUFFER_BYTES) {
        truncated = new TextDecoder().decode(bytes.subarray(bytes.byteLength - MAX_BUFFER_BYTES));
      }
      const buffers = new Map(state.buffers);
      buffers.set(id, truncated);
      return { buffers };
    }),

  clearBuffer: (id) =>
    set((state) => {
      const buffers = new Map(state.buffers);
      buffers.delete(id);
      return { buffers };
    }),
}));
