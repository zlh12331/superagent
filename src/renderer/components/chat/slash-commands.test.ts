// src/renderer/components/chat/slash-commands.test.ts
// 斜杠命令执行器纯分发回归（命令 → 动作唯一映射点）

import { describe, expect, it, vi } from 'vitest';

import { executeSlashCommand, type SlashCommandDeps } from './slash-commands';

function createDeps(): SlashCommandDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    navigateToHome: vi.fn(),
    clearMessages: vi.fn(),
    openShortcutHelp: vi.fn(),
    openModelMenu: vi.fn(),
    compact: vi.fn(),
    interrupt: vi.fn(),
    sendMessage: vi.fn(),
    prefillGoal: vi.fn(),
  } as never;
}

describe('executeSlashCommand', () => {
  it('/new → navigateToHome', () => {
    const deps = createDeps();
    executeSlashCommand('new', deps);
    expect(deps.navigateToHome).toHaveBeenCalledOnce();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('/clear → clearMessages', () => {
    const deps = createDeps();
    executeSlashCommand('clear', deps);
    expect(deps.clearMessages).toHaveBeenCalledOnce();
  });

  it('/help → openShortcutHelp；/models → openModelMenu', () => {
    const deps = createDeps();
    executeSlashCommand('help', deps);
    executeSlashCommand('models', deps);
    expect(deps.openShortcutHelp).toHaveBeenCalledOnce();
    expect(deps.openModelMenu).toHaveBeenCalledOnce();
  });

  it('/compact → compact；/interrupt → interrupt', () => {
    const deps = createDeps();
    executeSlashCommand('compact', deps);
    executeSlashCommand('interrupt', deps);
    expect(deps.compact).toHaveBeenCalledOnce();
    expect(deps.interrupt).toHaveBeenCalledOnce();
  });

  it('/demo → sendMessage("/demo")；/limit → sendMessage("/limit")', () => {
    const deps = createDeps();
    executeSlashCommand('demo', deps);
    executeSlashCommand('limit', deps);
    expect(deps.sendMessage).toHaveBeenNthCalledWith(1, '/demo');
    expect(deps.sendMessage).toHaveBeenNthCalledWith(2, '/limit');
  });

  it('/goal → prefillGoal（预填 "/goal " 等待补充需求）', () => {
    const deps = createDeps();
    executeSlashCommand('goal', deps);
    expect(deps.prefillGoal).toHaveBeenCalledOnce();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('每个命令只触发一个依赖（互不串扰）', () => {
    const deps = createDeps();
    executeSlashCommand('new', deps);
    expect(deps.clearMessages).not.toHaveBeenCalled();
    expect(deps.compact).not.toHaveBeenCalled();
    expect(deps.interrupt).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
