// src/renderer/stores/__tests__/stores-gaps-2.test.ts
// stores 层批次2 缺口补全：confirm-dialog/ui/welcome/reasoning-collapse/sessions（激活会话）
//
// 测试要点（真实 Zustand store，无 mock；beforeEach 重置状态与 localStorage）：
// 1. confirm-dialog：confirm/prompt 命令式 Promise、FIFO 排队、空态 _resolve 无副作用
// 2. ui：设置/命令面板开关、侧栏视图、折叠切换置位 manual
// 3. welcome：进入/退出欢迎模式、与激活会话的一致性约束
// 4. reasoning-collapse：显式覆盖设置与清除
// 5. sessions（激活会话）：设置/清空/持久化

import { beforeEach, describe, expect, it } from 'vitest';
import { useActiveSessionStore } from '../persistent/sessions-store';
import { confirm, prompt, useConfirmDialogStore } from '../transient/confirm-dialog-store';
import { useReasoningCollapseStore } from '../transient/reasoning-collapse-store';
import { useUiStore } from '../transient/ui-store';
import { useWelcomeStore } from '../transient/welcome-store';

describe('stores 批次2 缺口补全', () => {
  beforeEach(() => {
    localStorage.clear();
    useConfirmDialogStore.setState({ currentRequest: null, queue: [] });
    useUiStore.setState({
      settingsOpen: false,
      paletteOpen: false,
      sidebarView: 'threads',
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      sidebarManual: false,
      rightPanelManual: false,
      devPanelTab: 'info',
    });
    useWelcomeStore.setState({ isWelcomeMode: true, pendingWorkingDir: null });
    useReasoningCollapseStore.setState({ overrides: new Map() });
    useActiveSessionStore.setState({ activeSessionId: null });
  });

  describe('confirm-dialog-store', () => {
    it('confirm 确认：resolve(true) → Promise<boolean> true', async () => {
      const pending = confirm({ title: '删除', message: '不可撤销' });
      expect(useConfirmDialogStore.getState().currentRequest?.kind).toBe('confirm');
      useConfirmDialogStore.getState()._resolve(true);
      await expect(pending).resolves.toBe(true);
      expect(useConfirmDialogStore.getState().currentRequest).toBeNull();
    });

    it('confirm 取消：非 true 结果一律返回 false', async () => {
      const pending = confirm({ title: '删除', message: '不可撤销' });
      useConfirmDialogStore.getState()._resolve(false);
      await expect(pending).resolves.toBe(false);
    });

    it('prompt 确认：返回字符串；取消返回 null', async () => {
      const okCase = prompt({ title: '重命名', label: '新名称' });
      useConfirmDialogStore.getState()._resolve('  new-name  ');
      await expect(okCase).resolves.toBe('  new-name  ');

      const cancelCase = prompt({ title: '重命名', label: '新名称' });
      useConfirmDialogStore.getState()._resolve(false);
      await expect(cancelCase).resolves.toBeNull();
    });

    it('FIFO 排队：已有弹窗时后到请求排队，逐个激活', async () => {
      const first = confirm({ title: '一', message: '1' });
      const second = confirm({ title: '二', message: '2' });
      const state = useConfirmDialogStore.getState();
      expect(state.currentRequest?.confirmOptions?.title).toBe('一');
      expect(state.queue).toHaveLength(1);

      useConfirmDialogStore.getState()._resolve(true);
      await expect(first).resolves.toBe(true);
      // 第二个请求被激活
      expect(useConfirmDialogStore.getState().currentRequest?.confirmOptions?.title).toBe('二');
      expect(useConfirmDialogStore.getState().queue).toHaveLength(0);

      useConfirmDialogStore.getState()._resolve(false);
      await expect(second).resolves.toBe(false);
    });

    it('_resolve 空态：无弹窗时调用无副作用', () => {
      expect(() => useConfirmDialogStore.getState()._resolve(true)).not.toThrow();
      expect(useConfirmDialogStore.getState().currentRequest).toBeNull();
    });
  });

  describe('ui-store', () => {
    it('设置对话框开关', () => {
      useUiStore.getState().openSettings();
      expect(useUiStore.getState().settingsOpen).toBe(true);
      useUiStore.getState().closeSettings();
      expect(useUiStore.getState().settingsOpen).toBe(false);
    });

    it('命令面板开关', () => {
      useUiStore.getState().openPalette();
      expect(useUiStore.getState().paletteOpen).toBe(true);
      useUiStore.getState().closePalette();
      expect(useUiStore.getState().paletteOpen).toBe(false);
    });

    it('侧栏视图切换', () => {
      useUiStore.getState().setSidebarView('fileTree');
      expect(useUiStore.getState().sidebarView).toBe('fileTree');
    });

    it('toggleSidebar：翻转折叠态并置位 manual（断点不再覆盖）', () => {
      useUiStore.getState().toggleSidebar();
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
      expect(useUiStore.getState().sidebarManual).toBe(true);
      useUiStore.getState().toggleSidebar();
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    });

    it('toggleRightPanel：翻转折叠态并置位 manual', () => {
      useUiStore.getState().toggleRightPanel();
      expect(useUiStore.getState().rightPanelCollapsed).toBe(true);
      expect(useUiStore.getState().rightPanelManual).toBe(true);
    });

    it('setSidebarCollapsed / setRightPanelCollapsed：直接设置不触碰 manual', () => {
      useUiStore.getState().setSidebarCollapsed(true);
      useUiStore.getState().setRightPanelCollapsed(true);
      const s = useUiStore.getState();
      expect(s.sidebarCollapsed).toBe(true);
      expect(s.rightPanelCollapsed).toBe(true);
      expect(s.sidebarManual).toBe(false);
      expect(s.rightPanelManual).toBe(false);
    });

    it('DevPanel tab 切换', () => {
      useUiStore.getState().setDevPanelTab('terminal');
      expect(useUiStore.getState().devPanelTab).toBe('terminal');
    });
  });

  describe('welcome-store', () => {
    it('enterWelcomeMode：进入欢迎模式并携带预设目录', () => {
      useWelcomeStore.getState().exitWelcomeMode();
      useWelcomeStore.getState().enterWelcomeMode('/proj');
      const s = useWelcomeStore.getState();
      expect(s.isWelcomeMode).toBe(true);
      expect(s.pendingWorkingDir).toBe('/proj');
    });

    it('enterWelcomeMode 一致性：清空激活会话（欢迎页 + 激活会话不可并存）', () => {
      useActiveSessionStore.getState().setActiveSession('chat-9');
      useWelcomeStore.getState().enterWelcomeMode();
      expect(useActiveSessionStore.getState().activeSessionId).toBeNull();
    });

    it('exitWelcomeMode：退出并清空预设目录', () => {
      useWelcomeStore.getState().enterWelcomeMode('/proj');
      useWelcomeStore.getState().exitWelcomeMode();
      const s = useWelcomeStore.getState();
      expect(s.isWelcomeMode).toBe(false);
      expect(s.pendingWorkingDir).toBeNull();
    });

    it('setWelcomeMode(true)：保留现有 pendingWorkingDir（避免误清）', () => {
      useWelcomeStore.getState().setPendingWorkingDir('/keep');
      useWelcomeStore.getState().setWelcomeMode(true);
      expect(useWelcomeStore.getState().pendingWorkingDir).toBe('/keep');
    });

    it('setWelcomeMode(false)：清空 pendingWorkingDir', () => {
      useWelcomeStore.getState().setPendingWorkingDir('/drop');
      useWelcomeStore.getState().setWelcomeMode(false);
      expect(useWelcomeStore.getState().pendingWorkingDir).toBeNull();
    });

    it('setPendingWorkingDir：仅更新目录不触碰 welcome 标志', () => {
      useWelcomeStore.getState().exitWelcomeMode();
      useWelcomeStore.getState().setPendingWorkingDir('/dir');
      const s = useWelcomeStore.getState();
      expect(s.isWelcomeMode).toBe(false);
      expect(s.pendingWorkingDir).toBe('/dir');
    });
  });

  describe('reasoning-collapse-store', () => {
    it('setCollapsed：记录显式覆盖', () => {
      useReasoningCollapseStore.getState().setCollapsed('msg-1', true);
      useReasoningCollapseStore.getState().setCollapsed('msg-2', false);
      const overrides = useReasoningCollapseStore.getState().overrides;
      expect(overrides.get('msg-1')).toBe(true);
      expect(overrides.get('msg-2')).toBe(false);
    });

    it('setCollapsed(null)：清除覆盖回到 settings 默认', () => {
      useReasoningCollapseStore.getState().setCollapsed('msg-1', true);
      useReasoningCollapseStore.getState().setCollapsed('msg-1', null);
      expect(useReasoningCollapseStore.getState().overrides.has('msg-1')).toBe(false);
    });

    it('覆盖不可变更新：每次生成新 Map（不 mutate 旧引用）', () => {
      const before = useReasoningCollapseStore.getState().overrides;
      useReasoningCollapseStore.getState().setCollapsed('msg-1', true);
      expect(useReasoningCollapseStore.getState().overrides).not.toBe(before);
      expect(before.size).toBe(0);
    });
  });

  describe('sessions-store（激活会话）', () => {
    it('setActiveSession / clearActiveSession', () => {
      useActiveSessionStore.getState().setActiveSession('chat-1');
      expect(useActiveSessionStore.getState().activeSessionId).toBe('chat-1');
      useActiveSessionStore.getState().clearActiveSession();
      expect(useActiveSessionStore.getState().activeSessionId).toBeNull();
    });

    it('持久化：写入 localStorage（code-agent:active-session）', () => {
      useActiveSessionStore.getState().setActiveSession('chat-2');
      const raw = localStorage.getItem('code-agent:active-session');
      expect(raw).not.toBeNull();
      if (raw !== null) {
        expect(JSON.parse(raw)).toMatchObject({ state: { activeSessionId: 'chat-2' } });
      }
    });
  });
});
