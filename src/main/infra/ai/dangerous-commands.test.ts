// src/main/infra/ai/dangerous-commands.test.ts
// 危险命令检测单测：破坏性拦截 / 意图豁免 / 只读白名单

import { describe, expect, it } from 'vitest';
import { detectDangerousCommand, isSafeReadOnlyCommand } from './tools/dangerous-commands';

describe('detectDangerousCommand', () => {
  it('git reset --hard：判定为破坏性（git-destructive）', () => {
    const decision = detectDangerousCommand('git reset --hard HEAD~3');
    expect(decision.isDangerous).toBe(true);
    expect(decision.category).toBe('git-destructive');
  });

  it('git clean -f：判定为破坏性', () => {
    expect(detectDangerousCommand('git clean -fd').isDangerous).toBe(true);
  });

  it('git checkout -- .：判定为破坏性', () => {
    expect(detectDangerousCommand('git checkout -- .').isDangerous).toBe(true);
  });

  it('terraform destroy：判定为破坏性（iac-destroy）', () => {
    const decision = detectDangerousCommand('terraform destroy -auto-approve');
    expect(decision.isDangerous).toBe(true);
    expect(decision.category).toBe('iac-destroy');
  });

  it('安全命令：不判定为破坏性', () => {
    expect(detectDangerousCommand('git status').isDangerous).toBe(false);
    expect(detectDangerousCommand('pnpm test').isDangerous).toBe(false);
    expect(detectDangerousCommand('ls -la').isDangerous).toBe(false);
  });

  it('用户显式意图：豁免破坏性拦截（用户意图优先）', () => {
    const decision = detectDangerousCommand('git reset --hard HEAD', '请 discard 所有更改');
    expect(decision.isDangerous).toBe(false);
  });

  it('无意图关键词：不豁免', () => {
    const decision = detectDangerousCommand('git reset --hard HEAD', '帮我看看这个项目');
    expect(decision.isDangerous).toBe(true);
  });
});

describe('isSafeReadOnlyCommand', () => {
  it('只读命令：自动放行', () => {
    expect(isSafeReadOnlyCommand('ls -la')).toBe(true);
    expect(isSafeReadOnlyCommand('git status')).toBe(true);
    expect(isSafeReadOnlyCommand('cat src/main.ts')).toBe(true);
    expect(isSafeReadOnlyCommand('pnpm list')).toBe(true);
  });

  it('非只读命令：不自动放行', () => {
    expect(isSafeReadOnlyCommand('rm -rf node_modules')).toBe(false);
    expect(isSafeReadOnlyCommand('git push')).toBe(false);
    expect(isSafeReadOnlyCommand('pnpm install')).toBe(false);
  });
});
