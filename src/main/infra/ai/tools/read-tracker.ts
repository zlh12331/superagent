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
