// src/renderer/components/settings/sections/__tests__/seg-control-consumers.test.tsx
// SegControl 消费方的集成回归（editor / workspace）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09 审计）：SegControl 曾把 Radix 的「反选空串」透传给 onChange，
// 而这两个消费方都做 `Number(value)` 写库：
// - workspace：「默认展开层级」被写成 0 → useFileTree 的
//   `Math.max(0, depth - 1)` 得 0 → 默认展开链彻底失效（无报错）
// - editor：「字号」被写成 0
// 且受控值变 '0' 后无选项匹配，控件显示「什么都没选」。
// settings-controls 的单测已锁定 SegControl 本身；此处锁定**端到端**
// ——即点击已选项后，持久化 store 的值不被改写。
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/stores/persistent/settings-store';

import { EditorSection } from '../editor-section';
import { WorkspaceSection } from '../workspace-section';

// 这两个 section 只读写 settings-store（不触达 IPC），故无需 mock window.api
describe('SegControl 消费方：点击已选项不得写坏设置', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 还原为出厂默认（字号 14 / 展开层级 2）
    useSettingsStore.setState((s) => ({
      editor: { ...s.editor, fontSize: 14 },
      workspace: { ...s.workspace, defaultExpandDepth: 2 },
    }));
  });

  it('编辑器：点击已选中字号（14）→ 字号保持 14，不被写成 0', async () => {
    render(<EditorSection />);
    // 当前值 14 已选中；再点一次（Radix 会触发反选空串）
    const items = screen.getAllByRole('radio');
    const fourteen = items.find((el) => el.textContent === '14');
    expect(fourteen).toBeDefined();
    await userEvent.click(fourteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(14);
  });

  it('工作区：点击已选中展开层级（2）→ 保持 2，不被写成 0', async () => {
    render(<WorkspaceSection />);
    const items = screen.getAllByRole('radio');
    // 展开层级选项为 1/2/3（取 textContent 精确匹配，避开其它控件）
    const two = items.find((el) => el.textContent === '2');
    expect(two).toBeDefined();
    await userEvent.click(two as HTMLElement);

    // 关键回归：0 会让文件树默认展开链失效
    expect(useSettingsStore.getState().workspace.defaultExpandDepth).toBe(2);
  });

  it('编辑器：切换到另一档位仍正常写入（修复未破坏正常路径）', async () => {
    render(<EditorSection />);
    const items = screen.getAllByRole('radio');
    const sixteen = items.find((el) => el.textContent === '16');
    await userEvent.click(sixteen as HTMLElement);

    expect(useSettingsStore.getState().editor.fontSize).toBe(16);
  });
});
