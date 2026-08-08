// src/main/infra/ai/tools/read-tracker.ts
// 已读文件跟踪（priorReadEnforcement：编辑前必须先读）
// ──────────────────────────────────────────────────────────────
// 对齐 qwen-code priorReadEnforcement 语义：
// - read_file 成功执行 → 记录该会话已读文件路径
// - write_file/edit_file 修改已存在文件前 → 校验目标已读，未读返回
//   「请先 read_file」错误，防止 LLM 在未了解文件内容时盲目编辑
//
// 作用域：会话级（sessionId → 已读路径集合），回合结束清理
// ──────────────────────────────────────────────────────────────

/** 已读文件跟踪（模块级单例，read/write/edit 工具消费） */
class ReadTracker {
  /** sessionId → 已读文件绝对路径集合 */
  private readonly bySession = new Map<string, Set<string>>();

  /** 记录已读文件 */
  record(sessionId: string, absolutePath: string): void {
    let set = this.bySession.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(absolutePath);
  }

  /** 目标文件是否已在本会话读取 */
  has(sessionId: string, absolutePath: string): boolean {
    return this.bySession.get(sessionId)?.has(absolutePath) ?? false;
  }

  /** 清除会话记录（回合结束调用，避免跨回合累积） */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** 模块级单例 */
export const readTracker = new ReadTracker();
