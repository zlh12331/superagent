// read-tracker.ts：会话级文件读取登记表——read_file 计数（loop-detector 判同文件连读的数据源）
class ReadTracker {
  private readonly bySession = new Map<string, Set<string>>();

  record(sessionId: string, absolutePath: string): void {
    let set = this.bySession.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(absolutePath);
  }

  has(sessionId: string, absolutePath: string): boolean {
    return this.bySession.get(sessionId)?.has(absolutePath) ?? false;
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

export const readTracker = new ReadTracker();
