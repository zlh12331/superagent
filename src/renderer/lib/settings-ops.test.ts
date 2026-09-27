// src/renderer/lib/settings-ops.test.ts
// 设置域 IPC 桥行为测试：无桥降级语义 + 成功路径 + unwrap/业务失败路径
// 分组对齐源码：whitelist/tool · mcp · memory · skill · im · settings · update/session/app · browser
// 模式：每个 it 只覆盖一条路径（无桥/成功/失败分文件夹隔离），
//      避免「无桥后同用例再注入 mock」把 window.api 置空后写属性。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from './ipc-factories';
import {
  addWhitelistEntry,
  clearAllMemories,
  clearSessionMemory,
  clearUpdateCache,
  configureBrowser,
  exportAllSessions,
  exportDiagnostics,
  fetchImAllowedGroups,
  getLoginItemSettings,
  getMemoryStatus,
  getRecentTurns,
  getUpdateCacheInfo,
  getUsageSummary,
  IM_ALLOWED_GROUPS_SETTING_KEY,
  learnSkill,
  listImChannels,
  listLearnedSkills,
  listMcpServers,
  listSessionMemories,
  listSkills,
  listTools,
  listWhitelistEntries,
  openDataDirChecked,
  removeLearnedSkill,
  removeWhitelistEntry,
  saveImAllowedGroups,
  setLoginItemSettings,
  startImChannel,
  startMcpServer,
  stopImChannel,
  stopMcpServer,
  subscribeLoginItemChanged,
} from './settings-ops';

/** 注入 window.api 某域方法（setup.ts afterEach 会重置为空骨架） */
function mockApiDomain(domain: string, methods: Record<string, unknown>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)[domain] = methods;
}

/** 拔掉 window.api（浏览器模式 / preload 缺失） */
function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('settings-ops', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── whitelist / tool ─────────────────────────────────────

  describe('whitelist', () => {
    it('listWhitelistEntries 成功 → 返回条目', async () => {
      const entries = [{ toolName: 'bash', pattern: 'pnpm *' }];
      mockApiDomain('whitelist', { list: vi.fn(async () => ipcOk({ entries })) });
      await expect(listWhitelistEntries()).resolves.toEqual({ entries });
    });

    it('listWhitelistEntries 无桥 → 空列表', async () => {
      removeBridge();
      await expect(listWhitelistEntries()).resolves.toEqual({ entries: [] });
    });

    it('listWhitelistEntries IPC 错误 → unwrap 抛 [CODE]', async () => {
      mockApiDomain('whitelist', { list: vi.fn(async () => ipcErr('DB_ERROR', 'boom')) });
      await expect(listWhitelistEntries()).rejects.toThrow(/\[DB_ERROR\]/);
    });

    it('addWhitelistEntry 成功 → ok:true', async () => {
      mockApiDomain('whitelist', { add: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(addWhitelistEntry({ toolName: 'bash', pattern: 'pnpm *' })).resolves.toEqual({
        ok: true,
      });
    });

    it('addWhitelistEntry 无桥 → 本地空操作 ok:true（不误报失败）', async () => {
      removeBridge();
      await expect(addWhitelistEntry({ toolName: 'bash', pattern: 'pnpm *' })).resolves.toEqual({
        ok: true,
      });
    });

    it('removeWhitelistEntry 成功 → ok:true', async () => {
      mockApiDomain('whitelist', { remove: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(removeWhitelistEntry({ toolName: 'bash', pattern: 'x' })).resolves.toEqual({
        ok: true,
      });
    });

    it('removeWhitelistEntry 无桥 → ok:true', async () => {
      removeBridge();
      await expect(removeWhitelistEntry({ toolName: 'bash', pattern: 'x' })).resolves.toEqual({
        ok: true,
      });
    });
  });

  describe('listTools', () => {
    it('成功 → 返回工具清单', async () => {
      const tools = [{ name: 'bash', permission: 'auto' }];
      mockApiDomain('tool', { list: vi.fn(async () => ipcOk({ tools })) });
      await expect(listTools()).resolves.toEqual({ tools });
    });

    it('无桥 → 空清单', async () => {
      removeBridge();
      await expect(listTools()).resolves.toEqual({ tools: [] });
    });
  });

  // ── mcp ──────────────────────────────────────────────────

  describe('mcp', () => {
    it('listMcpServers 成功 → 返回服务器列表', async () => {
      const servers = [{ name: 'fs', transport: 'stdio', status: 'running' }];
      mockApiDomain('mcp', { list: vi.fn(async () => ipcOk({ servers })) });
      await expect(listMcpServers()).resolves.toEqual({ servers });
    });

    it('listMcpServers 无桥 → 空列表', async () => {
      removeBridge();
      await expect(listMcpServers()).resolves.toEqual({ servers: [] });
    });

    it('startMcpServer stdio：不传 transport/url/headers', async () => {
      const startMock = vi.fn(async () => ipcOk({ ok: true }));
      mockApiDomain('mcp', { start: startMock });
      await startMcpServer({ name: 'fs', transport: 'stdio', command: 'npx', args: ['x'] });
      expect(startMock).toHaveBeenCalledWith({
        name: 'fs',
        command: 'npx',
        args: ['x'],
      });
    });

    it('startMcpServer sse：透传 transport/url/headers', async () => {
      const startMock = vi.fn(async () => ipcOk({ ok: true }));
      mockApiDomain('mcp', { start: startMock });
      await startMcpServer({
        name: 'remote',
        transport: 'sse',
        command: '',
        url: 'https://mcp.example',
        headers: { auth: 't' },
      });
      expect(startMock).toHaveBeenCalledWith({
        name: 'remote',
        transport: 'sse',
        url: 'https://mcp.example',
        headers: { auth: 't' },
        command: '',
      });
    });

    it('startMcpServer 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(
        startMcpServer({ name: 'fs', transport: 'stdio', command: 'npx' }),
      ).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('startMcpServer IPC 错误 → 抛 [CODE]', async () => {
      mockApiDomain('mcp', { start: vi.fn(async () => ipcErr('MCP_START_FAILED', 'boom')) });
      await expect(
        startMcpServer({ name: 'fs', transport: 'stdio', command: 'npx' }),
      ).rejects.toThrow(/\[MCP_START_FAILED\]/);
    });

    it('stopMcpServer 成功 → ok:true', async () => {
      mockApiDomain('mcp', { stop: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(stopMcpServer('fs')).resolves.toEqual({ ok: true });
    });

    it('stopMcpServer 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(stopMcpServer('fs')).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('stopMcpServer IPC 错误 → 抛 [CODE]', async () => {
      mockApiDomain('mcp', { stop: vi.fn(async () => ipcErr('MCP_STOP_FAILED', 'boom')) });
      await expect(stopMcpServer('fs')).rejects.toThrow(/\[MCP_STOP_FAILED\]/);
    });
  });

  // ── memory ───────────────────────────────────────────────

  describe('memory', () => {
    it('listSessionMemories 成功 → 返回记忆条目', async () => {
      const memories = [{ id: 'm1', text: 'hello' }];
      mockApiDomain('memory', { list: vi.fn(async () => ipcOk({ memories })) });
      await expect(listSessionMemories('s-1')).resolves.toEqual({ memories });
    });

    it('listSessionMemories 无桥 → 空列表', async () => {
      removeBridge();
      await expect(listSessionMemories('s-1')).resolves.toEqual({ memories: [] });
    });

    it('getMemoryStatus 成功 → 返回引擎状态', async () => {
      const status = { running: true, port: 9527 };
      mockApiDomain('memory', { status: vi.fn(async () => ipcOk(status)) });
      await expect(getMemoryStatus()).resolves.toEqual(status);
    });

    it('getMemoryStatus 无桥 → null（状态条不渲染）', async () => {
      removeBridge();
      await expect(getMemoryStatus()).resolves.toBeNull();
    });

    it('clearSessionMemory ok:true → resolve', async () => {
      mockApiDomain('memory', { clear: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(clearSessionMemory('s-1')).resolves.toBeUndefined();
    });

    it('clearSessionMemory ok:false → 抛业务失败（不冒充成功）', async () => {
      mockApiDomain('memory', { clear: vi.fn(async () => ipcOk({ ok: false })) });
      await expect(clearSessionMemory('s-1')).rejects.toThrow(/memory clear failed/);
    });

    it('clearSessionMemory 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(clearSessionMemory('s-1')).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('clearAllMemories ok:true → 返回 clearedSessions', async () => {
      mockApiDomain('memory', {
        clearAll: vi.fn(async () => ipcOk({ ok: true, clearedSessions: 3 })),
      });
      await expect(clearAllMemories()).resolves.toEqual({ clearedSessions: 3 });
    });

    it('clearAllMemories ok:false 带 message → 抛 message', async () => {
      mockApiDomain('memory', {
        clearAll: vi.fn(async () => ipcOk({ ok: false, message: 'engine down' })),
      });
      await expect(clearAllMemories()).rejects.toThrow(/engine down/);
    });

    it('clearAllMemories ok:false 无 message → 抛默认文案', async () => {
      mockApiDomain('memory', { clearAll: vi.fn(async () => ipcOk({ ok: false })) });
      await expect(clearAllMemories()).rejects.toThrow(/memory clear all failed/);
    });

    it('clearAllMemories 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(clearAllMemories()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });
  });

  // ── skill ────────────────────────────────────────────────

  describe('skill', () => {
    it('listSkills 成功 → 返回技能列表', async () => {
      const skills = [{ name: 's1', description: 'd', prompt: 'p' }];
      mockApiDomain('skill', { list: vi.fn(async () => ipcOk({ skills })) });
      await expect(listSkills()).resolves.toEqual({ skills });
    });

    it('listSkills 无桥 → 空列表', async () => {
      removeBridge();
      await expect(listSkills()).resolves.toEqual({ skills: [] });
    });

    it('listLearnedSkills 成功 → 返回已学技能', async () => {
      mockApiDomain('skill', {
        listLearned: vi.fn(async () => ipcOk([{ name: 'learned', description: 'd', prompt: 'p' }])),
      });
      await expect(listLearnedSkills()).resolves.toEqual([
        { name: 'learned', description: 'd', prompt: 'p' },
      ]);
    });

    it('listLearnedSkills 无桥 → 空数组', async () => {
      removeBridge();
      await expect(listLearnedSkills()).resolves.toEqual([]);
    });

    it('learnSkill 成功 → 返回技能', async () => {
      const learned = { name: 'n', description: 'd', prompt: 'p', replaced: false };
      mockApiDomain('skill', { learn: vi.fn(async () => ipcOk(learned)) });
      await expect(learnSkill('do X')).resolves.toEqual(learned);
    });

    it('learnSkill 无桥 → 空技能壳（本地空操作）', async () => {
      removeBridge();
      await expect(learnSkill('do X')).resolves.toEqual({
        name: '',
        description: '',
        prompt: '',
        replaced: false,
      });
    });

    it('removeLearnedSkill 成功 → removed:true', async () => {
      mockApiDomain('skill', { removeLearned: vi.fn(async () => ipcOk({ removed: true })) });
      await expect(removeLearnedSkill('n')).resolves.toEqual({ removed: true });
    });

    it('removeLearnedSkill 无桥 → removed:true', async () => {
      removeBridge();
      await expect(removeLearnedSkill('n')).resolves.toEqual({ removed: true });
    });
  });

  // ── im ───────────────────────────────────────────────────

  describe('im', () => {
    it('listImChannels 成功 → 返回渠道列表', async () => {
      const channels = [{ kind: 'qq', running: true }];
      mockApiDomain('im', { list: vi.fn(async () => ipcOk({ channels })) });
      await expect(listImChannels()).resolves.toEqual({ channels });
    });

    it('listImChannels 无桥 → 空列表', async () => {
      removeBridge();
      await expect(listImChannels()).resolves.toEqual({ channels: [] });
    });

    it('startImChannel 无 token / 空 token → 不传 token 字段', async () => {
      const startMock = vi.fn(async () => ipcOk({ ok: true }));
      mockApiDomain('im', { start: startMock });
      await startImChannel({ kind: 'qq' });
      expect(startMock).toHaveBeenLastCalledWith({ kind: 'qq' });
      await startImChannel({ kind: 'qq', token: '' });
      expect(startMock).toHaveBeenLastCalledWith({ kind: 'qq' });
    });

    it('startImChannel 有 token → 透传', async () => {
      const startMock = vi.fn(async () => ipcOk({ ok: true }));
      mockApiDomain('im', { start: startMock });
      await startImChannel({ kind: 'telegram', token: 'tg-token' });
      expect(startMock).toHaveBeenCalledWith({ kind: 'telegram', token: 'tg-token' });
    });

    it('startImChannel 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(startImChannel({ kind: 'qq' })).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('startImChannel IPC 错误 → 抛 [CODE]', async () => {
      mockApiDomain('im', { start: vi.fn(async () => ipcErr('IM_START_FAILED', 'boom')) });
      await expect(startImChannel({ kind: 'qq' })).rejects.toThrow(/\[IM_START_FAILED\]/);
    });

    it('stopImChannel 成功 → ok:true', async () => {
      mockApiDomain('im', { stop: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(stopImChannel('qq')).resolves.toEqual({ ok: true });
    });

    it('stopImChannel 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(stopImChannel('qq')).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('stopImChannel IPC 错误 → 抛 [CODE]', async () => {
      mockApiDomain('im', { stop: vi.fn(async () => ipcErr('IM_STOP_FAILED', 'boom')) });
      await expect(stopImChannel('qq')).rejects.toThrow(/\[IM_STOP_FAILED\]/);
    });
  });

  // ── settings（IM 群聊白名单） ─────────────────────────────

  describe('IM 群聊白名单', () => {
    it('fetchImAllowedGroups 数组 → 过滤非字符串', async () => {
      mockApiDomain('settings', {
        getAll: vi.fn(async () =>
          ipcOk({
            settings: {
              [IM_ALLOWED_GROUPS_SETTING_KEY]: ['qq:1', 2, 'tg:2', null],
            },
          }),
        ),
      });
      await expect(fetchImAllowedGroups()).resolves.toEqual(['qq:1', 'tg:2']);
    });

    it('fetchImAllowedGroups 非数组 → 回退空', async () => {
      mockApiDomain('settings', {
        getAll: vi.fn(async () => ipcOk({ settings: { [IM_ALLOWED_GROUPS_SETTING_KEY]: 'oops' } })),
      });
      await expect(fetchImAllowedGroups()).resolves.toEqual([]);
    });

    it('fetchImAllowedGroups 无桥 → 空列表', async () => {
      removeBridge();
      await expect(fetchImAllowedGroups()).resolves.toEqual([]);
    });

    it('fetchImAllowedGroups IPC 失败 → 抛（不吞成空白名单）', async () => {
      mockApiDomain('settings', { getAll: vi.fn(async () => ipcErr('DB_ERROR', 'boom')) });
      await expect(fetchImAllowedGroups()).rejects.toThrow(/\[DB_ERROR\]/);
    });

    it('saveImAllowedGroups 覆盖式写入', async () => {
      const setMock = vi.fn(async () => ipcOk({ ok: true }));
      mockApiDomain('settings', { set: setMock });
      await expect(saveImAllowedGroups(['qq:1'])).resolves.toBeUndefined();
      expect(setMock).toHaveBeenCalledWith({
        key: IM_ALLOWED_GROUPS_SETTING_KEY,
        value: ['qq:1'],
      });
    });

    it('saveImAllowedGroups 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(saveImAllowedGroups(['qq:1'])).rejects.toThrow(/\[NO_BRIDGE\]/);
    });
  });

  // ── update / session / app ───────────────────────────────

  describe('update / session / app', () => {
    it('getUpdateCacheInfo 成功 → 返回缓存信息', async () => {
      const info = { path: 'C:/cache', bytes: 10, fileCount: 1 };
      mockApiDomain('update', { getCacheInfo: vi.fn(async () => ipcOk(info)) });
      await expect(getUpdateCacheInfo()).resolves.toEqual(info);
    });

    it('getUpdateCacheInfo 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(getUpdateCacheInfo()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('clearUpdateCache 成功 → 返回清空后缓存信息', async () => {
      mockApiDomain('update', {
        clearCache: vi.fn(async () => ipcOk({ path: 'C:/cache', bytes: 0, fileCount: 0 })),
      });
      await expect(clearUpdateCache()).resolves.toEqual({
        path: 'C:/cache',
        bytes: 0,
        fileCount: 0,
      });
    });

    it('clearUpdateCache 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(clearUpdateCache()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('exportAllSessions 成功 → 返回保存路径', async () => {
      mockApiDomain('session', {
        exportAll: vi.fn(async () => ipcOk({ saved: true, path: 'C:/out.zip' })),
      });
      await expect(exportAllSessions()).resolves.toEqual({ saved: true, path: 'C:/out.zip' });
    });

    it('exportAllSessions 无桥 → saved:false（统一按取消分支）', async () => {
      removeBridge();
      await expect(exportAllSessions()).resolves.toEqual({ saved: false });
    });

    it('openDataDirChecked 成功 → 回读 ok', async () => {
      mockApiDomain('app', { openDataDir: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(openDataDirChecked()).resolves.toEqual({ ok: true });
    });

    it('openDataDirChecked 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(openDataDirChecked()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('exportDiagnostics 成功 → 返回保存结果', async () => {
      const res = { saved: true, path: 'C:/diag.zip' };
      mockApiDomain('app', { exportDiagnostics: vi.fn(async () => ipcOk(res)) });
      await expect(exportDiagnostics()).resolves.toEqual(res);
    });

    it('exportDiagnostics 无桥 → null（静默不误报失败）', async () => {
      removeBridge();
      await expect(exportDiagnostics()).resolves.toBeNull();
    });

    it('getLoginItemSettings 成功 → 返回 OS 登录项状态', async () => {
      const item = { openAtLogin: true, supported: true, requiresApproval: false };
      mockApiDomain('app', { getLoginItemSettings: vi.fn(async () => ipcOk(item)) });
      await expect(getLoginItemSettings()).resolves.toEqual(item);
    });

    it('getLoginItemSettings 无桥 → 抛 [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(getLoginItemSettings()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('setLoginItemSettings 成功 → 返回写入后回读状态', async () => {
      const item = { openAtLogin: true, supported: true, requiresApproval: false };
      mockApiDomain('app', { setLoginItemSettings: vi.fn(async () => ipcOk(item)) });
      await expect(setLoginItemSettings({ openAtLogin: true })).resolves.toEqual(item);
    });

    it('setLoginItemSettings 无桥 → null（静默不操作）', async () => {
      removeBridge();
      await expect(setLoginItemSettings({ openAtLogin: true })).resolves.toBeNull();
    });

    it('subscribeLoginItemChanged 有桥 → 注册 handler 并返回 unsubscribe', () => {
      const unsub = vi.fn();
      const subscribeMock = vi.fn(() => unsub);
      mockApiDomain('app', { subscribeLoginItemChanged: subscribeMock });
      const handler = vi.fn();
      const off = subscribeLoginItemChanged(handler);
      expect(subscribeMock).toHaveBeenCalledWith(handler);
      off();
      expect(unsub).toHaveBeenCalledTimes(1);
    });

    it('subscribeLoginItemChanged 无桥 → no-op unsubscribe', () => {
      removeBridge();
      const off = subscribeLoginItemChanged(() => {});
      expect(() => off()).not.toThrow();
    });

    it('getUsageSummary 成功 → 返回 Token 用量汇总', async () => {
      const summary = { totalTokens: 100, days: [] };
      mockApiDomain('session', { getUsageSummary: vi.fn(async () => ipcOk(summary)) });
      await expect(getUsageSummary()).resolves.toEqual(summary);
    });

    it('getUsageSummary 无桥 → null', async () => {
      removeBridge();
      await expect(getUsageSummary()).resolves.toBeNull();
    });

    it('getRecentTurns 成功 → 返回回合列表', async () => {
      mockApiDomain('session', {
        getRecentTurns: vi.fn(async () => ipcOk({ turns: [{ id: 't1' }] })),
      });
      await expect(getRecentTurns(5)).resolves.toEqual([{ id: 't1' }]);
    });

    it('getRecentTurns 无桥 → 空回合列表', async () => {
      removeBridge();
      await expect(getRecentTurns(5)).resolves.toEqual([]);
    });
  });

  // ── browser ──────────────────────────────────────────────

  describe('configureBrowser', () => {
    it('有桥 → resolve true', async () => {
      mockApiDomain('browser', { configure: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(configureBrowser({ strictSandbox: true })).resolves.toBe(true);
    });

    it('无桥 → false（不抛）', async () => {
      removeBridge();
      await expect(configureBrowser({ strictSandbox: true })).resolves.toBe(false);
    });
  });
});
