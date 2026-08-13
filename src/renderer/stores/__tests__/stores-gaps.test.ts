// src/renderer/stores/__tests__/stores-gaps.test.ts
// stores 层批次1 缺口补全：draft/settings/tool/approvals/create-persistent 首次补测
//
// 测试要点（真实 Zustand store，无 mock；beforeEach 重置状态与 localStorage）：
// 1. draft：读写/覆盖/清除/持久化
// 2. settings：默认值/各 update 合并/migrate v2→v3（Meta+ → Ctrl+）
// 3. tool：pending/success/error 状态机/多会话分组/未找到 id
// 4. approvals：FIFO/approve/reject/dismiss/clearBySession/resolved 上限
// 5. create-persistent：key 前缀/partialize 过滤函数/migrate 透传

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistentStore } from '../persistent/create-persistent-store';
import { useDraftStore } from '../persistent/draft-store';
import {
  applySettingsSnapshot,
  migrateShortcuts,
  nextTheme,
  THEME_CYCLE,
  useSettingsStore,
} from '../persistent/settings-store';
import { useApprovalsStore } from '../transient/approvals-store';
import { useToolStore } from '../transient/tool-store';

/** persist 中间件附加的 rehydrate API（工厂返回类型未暴露，运行时存在；create-persistent 测试用） */
const rehydrate = (store: unknown): Promise<void> =>
  (store as unknown as { persist: { rehydrate: () => Promise<void> } }).persist.rehydrate();

describe('stores 批次1 缺口补全', () => {
  beforeEach(() => {
    localStorage.clear();
    useDraftStore.setState({ drafts: {} });
    useToolStore.setState({ callsBySession: new Map() });
    useApprovalsStore.setState({ pending: [], resolved: [] });
    // S1：settings 下沉 SQLite——内存态不再经 persist rehydrate 重置，
    // 显式重置回默认值（applySettingsSnapshot({}) = 全默认）
    applySettingsSnapshot({});
  });

  describe('draft-store', () => {
    it('getDraft 无草稿：返回空草稿（text 空 + attachments 空）', () => {
      expect(useDraftStore.getState().getDraft('chat-1')).toEqual({ text: '', attachments: [] });
    });

    it('setDraft 保存：getDraft 返回对应草稿', () => {
      useDraftStore.getState().setDraft('chat-1', { text: '草稿内容', attachments: ['/a.txt'] });
      expect(useDraftStore.getState().getDraft('chat-1')).toEqual({
        text: '草稿内容',
        attachments: ['/a.txt'],
      });
    });

    it('setDraft 覆盖旧值（空文本也覆盖）', () => {
      useDraftStore.getState().setDraft('chat-1', { text: '旧', attachments: [] });
      useDraftStore.getState().setDraft('chat-1', { text: '', attachments: ['/b'] });
      expect(useDraftStore.getState().getDraft('chat-1')).toEqual({
        text: '',
        attachments: ['/b'],
      });
    });

    it('clearDraft：删除草稿后回退空草稿', () => {
      useDraftStore.getState().setDraft('chat-1', { text: 'x', attachments: [] });
      useDraftStore.getState().clearDraft('chat-1');
      expect(useDraftStore.getState().getDraft('chat-1')).toEqual({ text: '', attachments: [] });
    });

    it('clearDraft 不存在的 chatId：不抛且状态不变', () => {
      expect(() => useDraftStore.getState().clearDraft('ghost')).not.toThrow();
    });

    it('持久化：setDraft 后写入 localStorage（code-agent:drafts）', () => {
      useDraftStore.getState().setDraft('chat-1', { text: '持久', attachments: [] });
      const raw = localStorage.getItem('code-agent:drafts');
      expect(raw).not.toBeNull();
      if (raw !== null) {
        expect(JSON.parse(raw)).toMatchObject({
          state: { drafts: { 'chat-1': { text: '持久', attachments: [] } } },
        });
      }
    });
  });

  describe('settings-store', () => {
    it('默认值：dark 主题 + deepseek AI + Ctrl 修饰键（非 mac）', () => {
      const s = useSettingsStore.getState();
      expect(s.theme).toBe('dark');
      expect(s.ai).toMatchObject({ defaultProvider: 'deepseek', temperature: 0.7 });
      expect(s.shortcuts.commandPalette).toContain('Ctrl+P');
      expect(s.experimental.reasoningCollapsed).toBe(true);
    });

    it('setTheme：更新主题', () => {
      useSettingsStore.getState().setTheme('light');
      expect(useSettingsStore.getState().theme).toBe('light');
    });

    it('nextTheme：三态循环 dark→light→system→dark（各入口共用）', () => {
      expect(THEME_CYCLE).toEqual({ dark: 'light', light: 'system', system: 'dark' });
      expect(nextTheme('dark')).toBe('light');
      expect(nextTheme('light')).toBe('system');
      expect(nextTheme('system')).toBe('dark');
    });

    it('updateAi：部分字段合并（保留其他字段）', () => {
      useSettingsStore.getState().updateAi({ temperature: 1.2 });
      const ai = useSettingsStore.getState().ai;
      expect(ai.temperature).toBe(1.2);
      expect(ai.defaultProvider).toBe('deepseek');
      expect(ai.thinking).toBe('high');
    });

    it('updateEditor / updateShortcuts / updateExperimental：部分合并', () => {
      useSettingsStore.getState().updateEditor({ vimMode: true });
      useSettingsStore.getState().updateShortcuts({ saveFile: 'Ctrl+S' });
      useSettingsStore.getState().updateExperimental({ scanlines: true });
      const s = useSettingsStore.getState();
      expect(s.editor).toMatchObject({ vimMode: true, fontSize: 14 });
      expect(s.shortcuts.saveFile).toBe('Ctrl+S');
      expect(s.shortcuts.commandPalette).toContain('Ctrl+');
      expect(s.experimental).toMatchObject({ scanlines: true, reasoningCollapsed: true });
    });

    it('S1 写穿透：updateAi 后经 settings:set IPC 落库（不再写 localStorage）', () => {
      const setMock = vi.fn(async () => ({ data: { ok: true } }));
      // 仅注入被测路径用到的方法（测试骨架为最小 mock）
      window.api.settings = { set: setMock } as never;
      useSettingsStore.getState().updateAi({ temperature: 0.5 });
      expect(setMock).toHaveBeenCalledWith({
        key: 'ai',
        value: expect.objectContaining({ temperature: 0.5 }),
      });
      // 不再写 localStorage（真源已迁移 SQLite）
      expect(localStorage.getItem('code-agent:settings')).toBeNull();
    });

    it('migrate v2→v3：Meta+ 快捷键归一化为 Ctrl+（非 mac）', () => {
      const legacy = {
        theme: 'dark',
        shortcuts: {
          commandPalette: 'Meta+P',
          saveFile: 'Meta+S',
          newSession: 'Meta+N',
        },
      };
      const migrated = migrateShortcuts(legacy);
      expect((migrated.shortcuts as Record<string, string>)['commandPalette']).toBe('Ctrl+P');
      expect((migrated.shortcuts as Record<string, string>)['saveFile']).toBe('Ctrl+S');
      expect((migrated.shortcuts as Record<string, string>)['newSession']).toBe('Ctrl+N');
    });

    it('migrate：旧数据缺 shortcuts → 返回原状态不抛', () => {
      expect(migrateShortcuts({ theme: 'light' })).toEqual({ theme: 'light' });
    });

    it('migrate：非 Meta 前缀快捷键保持原值', () => {
      const migrated = migrateShortcuts({
        theme: 'dark',
        shortcuts: {
          commandPalette: 'Ctrl+Shift+P',
          saveFile: 'Ctrl+X',
          searchFile: 'Meta+F',
        },
      });
      const shortcuts = migrated.shortcuts as Record<string, string>;
      expect(shortcuts['commandPalette']).toBe('Ctrl+Shift+P');
      expect(shortcuts['saveFile']).toBe('Ctrl+X');
      expect(shortcuts['searchFile']).toBe('Ctrl+F');
    });

    it('applySettingsSnapshot：快照合并默认值（缺字段补默认）', () => {
      applySettingsSnapshot({ theme: 'light', ai: { temperature: 1.1 } });
      const s = useSettingsStore.getState();
      expect(s.theme).toBe('light');
      expect(s.ai).toMatchObject({ temperature: 1.1, defaultProvider: 'deepseek' });
      expect(s.shortcuts.commandPalette).toContain('Ctrl+P');
    });
  });

  describe('tool-store', () => {
    const callInput = {
      id: 'call-1',
      sessionId: 'sess-a',
      toolName: 'grep',
      input: { pattern: 'x' },
      permission: 'auto' as const,
    };

    it('appendToolCall：创建 pending 项（title null / error null）', () => {
      useToolStore.getState().appendToolCall(callInput);
      const calls = useToolStore.getState().callsBySession.get('sess-a') ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        id: 'call-1',
        status: 'pending',
        title: null,
        error: null,
        resolvedAt: null,
      });
    });

    it('appendToolResult 成功：status success + output + resolvedAt', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore.getState().appendToolResult('call-1', { output: '匹配结果', error: null });
      const call = useToolStore.getState().callsBySession.get('sess-a')?.[0];
      expect(call?.status).toBe('success');
      expect(call?.output).toBe('匹配结果');
      expect(call?.resolvedAt).not.toBeNull();
    });

    it('appendToolResult 错误：status error + error 信息', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore.getState().appendToolResult('call-1', {
        output: null,
        error: { code: 'TOOL_EXECUTION_FAILED', message: 'boom' },
      });
      const call = useToolStore.getState().callsBySession.get('sess-a')?.[0];
      expect(call?.status).toBe('error');
      expect(call?.error).toEqual({ code: 'TOOL_EXECUTION_FAILED', message: 'boom' });
    });

    it('appendToolResult 未找到 id：状态不变', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore.getState().appendToolResult('ghost-id', { output: 'x', error: null });
      const call = useToolStore.getState().callsBySession.get('sess-a')?.[0];
      expect(call?.status).toBe('pending');
    });

    it('多会话分组：不同 sessionId 独立维护', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore.getState().appendToolCall({ ...callInput, id: 'call-2', sessionId: 'sess-b' });
      expect(useToolStore.getState().callsBySession.get('sess-a')).toHaveLength(1);
      expect(useToolStore.getState().callsBySession.get('sess-b')).toHaveLength(1);
    });

    it('appendToolResult 带 title：覆盖 null title', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore
        .getState()
        .appendToolResult('call-1', { output: 'x', error: null, title: '读取完成' });
      expect(useToolStore.getState().callsBySession.get('sess-a')?.[0]?.title).toBe('读取完成');
    });

    it('clearBySession：删除该会话全部调用', () => {
      useToolStore.getState().appendToolCall(callInput);
      useToolStore.getState().clearBySession('sess-a');
      expect(useToolStore.getState().callsBySession.get('sess-a')).toBeUndefined();
    });
  });

  describe('approvals-store', () => {
    const itemInput = {
      id: 'a-1',
      sessionId: 'sess-1',
      type: 'run_command' as const,
      title: '执行命令: npm test',
      description: 'npm test',
      input: { command: 'npm test' },
      createdAt: 100,
    };

    it('enqueue：pending 队列 FIFO 顺序', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().enqueue({ ...itemInput, id: 'a-2', createdAt: 200 });
      const pending = useApprovalsStore.getState().pending;
      expect(pending.map((a) => a.id)).toEqual(['a-1', 'a-2']);
      expect(pending[0]?.status).toBe('pending');
      expect(pending[0]?.resolvedAt).toBeNull();
    });

    it('approve：pending 移除 + resolved approved + resolvedAt', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().approve('a-1');
      expect(useApprovalsStore.getState().pending).toHaveLength(0);
      expect(useApprovalsStore.getState().resolved[0]).toMatchObject({
        id: 'a-1',
        status: 'approved',
        resolvedAt: expect.any(Number),
      });
    });

    it('reject：resolved rejected', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().reject('a-1');
      expect(useApprovalsStore.getState().resolved[0]?.status).toBe('rejected');
    });

    it('approve 不存在的 id：状态不变', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().approve('ghost');
      expect(useApprovalsStore.getState().pending).toHaveLength(1);
      expect(useApprovalsStore.getState().resolved).toHaveLength(0);
    });

    it('reject 不存在的 id：状态不变', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().reject('ghost');
      expect(useApprovalsStore.getState().pending).toHaveLength(1);
      expect(useApprovalsStore.getState().resolved).toHaveLength(0);
    });

    it('dismiss：从 resolved 移除', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().approve('a-1');
      useApprovalsStore.getState().dismiss('a-1');
      expect(useApprovalsStore.getState().resolved).toHaveLength(0);
    });

    it('clearBySession：清空该会话 pending（保留其他会话）', () => {
      useApprovalsStore.getState().enqueue(itemInput);
      useApprovalsStore.getState().enqueue({ ...itemInput, id: 'a-2', sessionId: 'sess-2' });
      useApprovalsStore.getState().clearBySession('sess-1');
      expect(useApprovalsStore.getState().pending.map((a) => a.id)).toEqual(['a-2']);
    });

    it('resolved 上限：超过 20 条截断最旧', () => {
      for (let i = 1; i <= 25; i += 1) {
        useApprovalsStore.getState().enqueue({ ...itemInput, id: `a-${i}`, createdAt: i });
        useApprovalsStore.getState().approve(`a-${i}`);
      }
      expect(useApprovalsStore.getState().resolved).toHaveLength(20);
      // 保留最新 20 条（id 大者新）
      expect(useApprovalsStore.getState().resolved[0]?.id).toBe('a-25');
      expect(useApprovalsStore.getState().resolved[19]?.id).toBe('a-6');
    });
  });

  describe('create-persistent-store', () => {
    it('工厂创建：state + action 可用，storage key 带前缀', () => {
      const useTestStore = createPersistentStore<{ count: number; inc: () => void }>()(
        (set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }),
        { name: 'test-gap' },
      );
      useTestStore.getState().inc();
      expect(useTestStore.getState().count).toBe(1);
      const raw = localStorage.getItem('code-agent:test-gap');
      expect(raw).not.toBeNull();
      if (raw !== null) {
        // partialize 过滤函数：持久化数据不含 inc
        expect(JSON.parse(raw)).toMatchObject({ state: { count: 1 } });
        expect(JSON.parse(raw).state.inc).toBeUndefined();
      }
    });

    it('migrate 透传：版本迁移函数被执行', async () => {
      const migrate = (persisted: unknown): { count: number; inc: () => void } => {
        const old = persisted as { count?: number };
        return { count: (old.count ?? 0) + 100, inc: () => {} } as never;
      };
      localStorage.setItem(
        'code-agent:test-migrate',
        JSON.stringify({ state: { count: 1 }, version: 0 }),
      );
      const useMigrateStore = createPersistentStore<{ count: number; inc: () => void }>()(
        (set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }),
        { name: 'test-migrate', version: 1, migrate },
      );
      await rehydrate(useMigrateStore);
      expect(useMigrateStore.getState().count).toBe(101);
    });
  });
});
