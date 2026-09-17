// src/renderer/components/settings/sections/workspace-section.test.tsx
// WorkspaceSection 测试：「默认展开层级」SegControl 消费方端到端回归
// ──────────────────────────────────────────────────────────────
// 回归背景（2026-09 审计）：SegControl 曾把 Radix 的「反选空串」透传给 onChange，
// 消费方 `Number(value)` 写库会把「默认展开层级」写成 0 → useFileTree 的
// `Math.max(0, depth - 1)` 得 0 → 默认展开链彻底失效（无报错）。
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/stores/persistent/settings-store';

import { WorkspaceSection } from './workspace-section';

beforeEach(() => {
  vi.clearAllMocks();
  // 还原为出厂默认（展开层级 2）
  useSettingsStore.setState((s) => ({
    workspace: { ...s.workspace, defaultExpandDepth: 2 },
  }));
});

describe('WorkspaceSection', () => {
  it('回归：点击已选中展开层级（2）→ 保持 2，不被写成 0', async () => {
    render(<WorkspaceSection />);
    const items = screen.getAllByRole('radio');
    // 展开层级选项为 1/2/3（取 textContent 精确匹配，避开其它控件）
    const two = items.find((el) => el.textContent === '2');
    expect(two).toBeDefined();
    await userEvent.click(two as HTMLElement);

    // 关键回归：0 会让文件树默认展开链失效
    expect(useSettingsStore.getState().workspace.defaultExpandDepth).toBe(2);
  });
});
