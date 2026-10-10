import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsStore } from '@/stores/persistent/settings-store';

import { WorkspaceSection } from './workspace-section';

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState((s) => ({
    workspace: { ...s.workspace, defaultExpandDepth: 2 },
  }));
});

describe('WorkspaceSection', () => {
  it('回归：点击已选中展开层级（2）→ 保持 2，不被写成 0', async () => {
    render(<WorkspaceSection />);
    const items = screen.getAllByRole('radio');
    const two = items.find((el) => el.textContent === '2');
    expect(two).toBeDefined();
    await userEvent.click(two as HTMLElement);

    expect(useSettingsStore.getState().workspace.defaultExpandDepth).toBe(2);
  });
});
