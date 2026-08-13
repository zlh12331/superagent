// src/renderer/stores/transient/__tests__/terminal-store.test.ts
// terminal-store 单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. createTerminal：新增终端并设为激活，返回 id
// 2. setActiveTerminal：切换激活终端
// 3. closeTerminal：移除终端 + 清理 buffer + 自动切换激活终端
// 4. markExited：标记 alive=false
// 5. appendOutput：追加行 + 环形截断（超过 MAX_BUFFER_LINES 时保留尾部）
// 6. clearBuffer：清空指定终端的 buffer
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from '../terminal-store';

describe('terminal-store', () => {
  // 每个测试前重置 store（避免测试间状态污染）
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: [],
      activeTerminalId: null,
      buffers: new Map(),
    });
  });

  // ── createTerminal ──────────────────────────────────────
  describe('createTerminal', () => {
    it('新增终端并设为激活', () => {
      const id = useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      expect(id).toBe('term-1');
      const state = useTerminalStore.getState();
      expect(state.terminals).toHaveLength(1);
      expect(state.terminals[0]?.id).toBe('term-1');
      expect(state.terminals[0]?.alive).toBe(true);
      expect(state.terminals[0]?.createdAt).toBeTypeOf('number');
      expect(state.activeTerminalId).toBe('term-1');
    });

    it('支持创建多个终端（按创建顺序追加）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      const state = useTerminalStore.getState();
      expect(state.terminals).toHaveLength(2);
      expect(state.terminals[0]?.id).toBe('term-1');
      expect(state.terminals[1]?.id).toBe('term-2');
      // 后创建的设为激活
      expect(state.activeTerminalId).toBe('term-2');
    });
  });

  // ── setActiveTerminal ───────────────────────────────────
  describe('setActiveTerminal', () => {
    it('切换激活终端', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      useTerminalStore.getState().setActiveTerminal('term-1');
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-1');
    });
  });

  // ── closeTerminal ───────────────────────────────────────
  describe('closeTerminal', () => {
    it('移除终端并清理对应 buffer', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', 'line-1\nline-2');
      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('line-1\nline-2');

      useTerminalStore.getState().closeTerminal('term-1');

      const state = useTerminalStore.getState();
      expect(state.terminals).toHaveLength(0);
      expect(state.buffers.get('term-1')).toBeUndefined();
      expect(state.activeTerminalId).toBeNull();
    });

    it('关闭激活终端时自动切换到最后一个终端', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      // 此时激活的是 term-2
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-2');

      // 关闭 term-2，应自动激活 term-1（最后一个剩余终端）
      useTerminalStore.getState().closeTerminal('term-2');
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-1');
    });

    it('关闭非激活终端时激活态不变', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      useTerminalStore.getState().closeTerminal('term-1');
      expect(useTerminalStore.getState().activeTerminalId).toBe('term-2');
    });

    it('关闭不存在的终端 id 不报错（no-op）', () => {
      expect(() => {
        useTerminalStore.getState().closeTerminal('non-existent');
      }).not.toThrow();
    });
  });

  // ── markExited ──────────────────────────────────────────
  describe('markExited', () => {
    it('标记指定终端 alive=false（不影响其他终端）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().createTerminal({
        id: 'term-2',
        sessionId: 'session-2',
        title: 'pwsh',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      useTerminalStore.getState().markExited('term-1');

      const state = useTerminalStore.getState();
      const term1 = state.terminals.find((t) => t.id === 'term-1');
      const term2 = state.terminals.find((t) => t.id === 'term-2');
      expect(term1?.alive).toBe(false);
      expect(term2?.alive).toBe(true);
    });

    it('保留输出 buffer（用于退出后查看历史）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', 'line-1');
      useTerminalStore.getState().markExited('term-1');
      // buffer 不应被清理
      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('line-1');
    });
  });

  // ── appendOutput（P3：原始 ANSI 字符串累积）+ 字节环形截断 ──
  describe('appendOutput', () => {
    it('追加原始片段到空 buffer（ANSI 序列保持完整）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      useTerminalStore.getState().appendOutput('term-1', '\x1b[32mhello\x1b[0m world\r\n');

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe(
        '\x1b[32mhello\x1b[0m world\r\n',
      );
    });

    it('追加到已有 buffer（原样拼接，不切行）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', 'line-1\n');
      useTerminalStore.getState().appendOutput('term-1', 'line-2\nline-3');

      expect(useTerminalStore.getState().buffers.get('term-1')).toBe('line-1\nline-2\nline-3');
    });

    it('字节环形截断：超过 MAX_BUFFER_BYTES 时保留尾部字节', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });

      // 先填充 100KB（达上限）
      const firstChunk = 'a'.repeat(100 * 1024);
      useTerminalStore.getState().appendOutput('term-1', firstChunk);
      expect(
        new TextEncoder().encode(useTerminalStore.getState().buffers.get('term-1') ?? '')
          .byteLength,
      ).toBe(100 * 1024);

      // 再追加 1KB，应截断保留尾部 100KB（前 1KB 被淘汰）
      const secondChunk = 'b'.repeat(1024);
      useTerminalStore.getState().appendOutput('term-1', secondChunk);

      const buffer = useTerminalStore.getState().buffers.get('term-1') ?? '';
      expect(new TextEncoder().encode(buffer).byteLength).toBe(100 * 1024);
      // 保留尾部 100KB：前 1KB 'a' 被淘汰，剩余 99KB 'a' + 1KB 'b'
      expect(buffer.startsWith('a'.repeat(99 * 1024))).toBe(true);
      expect(buffer.endsWith('b'.repeat(1024))).toBe(true);
    });

    it('追加空字符串不报错（no-op）', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', '');
      // no-op：空片段不产生 buffer 条目（返回原 state）
      expect(useTerminalStore.getState().buffers.get('term-1')).toBeUndefined();
    });

    it('对未创建的 terminalId 也能追加（自动创建 buffer 条目）', () => {
      // 即使终端未注册，appendOutput 也应创建 buffer 条目
      // （虽然正常流程不会这样调用，但 store 应有容错）
      useTerminalStore.getState().appendOutput('unknown-id', 'orphan-line');
      expect(useTerminalStore.getState().buffers.get('unknown-id')).toBe('orphan-line');
    });
  });

  // ── clearBuffer ────────────────────────────────────────
  describe('clearBuffer', () => {
    it('清空指定终端的 buffer', () => {
      useTerminalStore.getState().createTerminal({
        id: 'term-1',
        sessionId: 'session-1',
        title: 'bash',
        pid: null,
        cwd: '/tmp',
        alive: true,
      });
      useTerminalStore.getState().appendOutput('term-1', 'line-1\nline-2');

      useTerminalStore.getState().clearBuffer('term-1');

      // clearBuffer 删除 entry（get 返回 undefined）
      expect(useTerminalStore.getState().buffers.get('term-1')).toBeUndefined();
    });

    it('清空不存在的 terminalId 不报错（no-op）', () => {
      expect(() => {
        useTerminalStore.getState().clearBuffer('non-existent');
      }).not.toThrow();
    });
  });
});
