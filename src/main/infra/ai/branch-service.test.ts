// src/main/infra/ai/branch-service.test.ts
// 会话分支服务单测：分类纯函数 + 记录/摘要

import { describe, expect, it } from 'vitest';
import { BranchService, classifyBranch } from './agent/branch-service';

describe('classifyBranch（纯函数）', () => {
  it('无回退（顺序追加）：ordinary', () => {
    expect(classifyBranch({ parentTurnId: null })).toBe('ordinary');
  });

  it('回退到历史点首次分叉：rewind-descendant', () => {
    expect(classifyBranch({ parentTurnId: 't2', branchPointHasSibling: false })).toBe(
      'rewind-descendant',
    );
  });

  it('回退到已有其他后继的点：rewind-sibling', () => {
    expect(classifyBranch({ parentTurnId: 't2', branchPointHasSibling: true })).toBe(
      'rewind-sibling',
    );
  });

  it('连续多次回退：mixed-rewind', () => {
    expect(classifyBranch({ parentTurnId: 't3', multipleRewinds: true })).toBe('mixed-rewind');
  });
});

describe('BranchService（记录）', () => {
  it('record：顺序追加为 ordinary，并记录在案', () => {
    const service = new BranchService();
    expect(service.record('s1', 't1', null)).toBe('ordinary');
    expect(service.record('s1', 't2', null)).toBe('ordinary');
    expect(service.list('s1')).toHaveLength(2);
  });

  it('record：首次回退为 descendant，再回退同点为 sibling', () => {
    const service = new BranchService();
    service.record('s1', 't1', null);
    service.record('s1', 't2', null);
    expect(service.record('s1', 't3', 't1')).toBe('rewind-descendant');
    expect(service.record('s1', 't4', 't1')).toBe('rewind-sibling');
    const records = service.list('s1');
    expect(records[2]?.classification).toBe('rewind-descendant');
    expect(records[3]?.classification).toBe('rewind-sibling');
  });

  it('summary：按分支点聚合后代计数', () => {
    const service = new BranchService();
    service.record('s1', 't1', null);
    service.record('s1', 't2', null);
    service.record('s1', 't3', 't1');
    service.record('s1', 't4', 't1');
    service.record('s1', 't5', 't2');
    const summary = service.summary('s1');
    expect(summary).toHaveLength(2);
    expect(summary.find((s) => s.parentTurnId === 't1')?.count).toBe(2);
    expect(summary.find((s) => s.parentTurnId === 't2')?.count).toBe(1);
  });

  it('clear：清空会话分支记录', () => {
    const service = new BranchService();
    service.record('s1', 't1', null);
    service.clear('s1');
    expect(service.list('s1')).toHaveLength(0);
  });

  it('会话隔离：不同会话互不影响', () => {
    const service = new BranchService();
    service.record('s1', 't1', null);
    service.record('s2', 't1', null);
    expect(service.list('s1')).toHaveLength(1);
    expect(service.list('s2')).toHaveLength(1);
  });
});
