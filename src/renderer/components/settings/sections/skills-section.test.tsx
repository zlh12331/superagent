// src/renderer/components/settings/sections/skills-section.test.tsx
// SkillsSection 单测：已学技能列表 / 移除 / 学习 / 内置分组
// 数据源：window.api.skill.listLearned/list/learn/removeLearned（全部 stub）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillsSection } from './skills-section';

const mocks = vi.hoisted(() => ({
  listLearned: vi.fn(async () => ({ data: [{ name: 'ts-unit', description: 'TS 单测骨架' }] })),
  list: vi.fn(async () => ({
    data: {
      skills: [
        { name: 'ts-unit', description: 'TS 单测骨架' },
        { name: 'code-review', description: '代码审查' },
      ],
    },
  })),
  learn: vi.fn(async () => ({ data: { name: 'x', description: '', prompt: '', replaced: false } })),
  removeLearned: vi.fn(async () => ({ data: { removed: true } })),
}));

function renderSection(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SkillsSection />
    </QueryClientProvider>,
  );
}

describe('SkillsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listLearned.mockResolvedValue({
      data: [{ name: 'ts-unit', description: 'TS 单测骨架' }],
    });
    mocks.list.mockResolvedValue({
      data: {
        skills: [
          { name: 'ts-unit', description: 'TS 单测骨架' },
          { name: 'code-review', description: '代码审查' },
        ],
      },
    });
    mocks.learn.mockResolvedValue({
      data: { name: 'x', description: '', prompt: '', replaced: false },
    });
    mocks.removeLearned.mockResolvedValue({ data: { removed: true } });
    window.api = {
      skill: {
        listLearned: mocks.listLearned,
        list: mocks.list,
        learn: mocks.learn,
        removeLearned: mocks.removeLearned,
      },
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染已学技能列表', async () => {
    renderSection();
    expect(await screen.findByText('ts-unit')).toBeInTheDocument();
  });

  it('已学技能可移除 → 调 skill.removeLearned', async () => {
    renderSection();
    await screen.findByText('ts-unit');
    const removeBtn = screen.getByLabelText('移除技能');
    await userEvent.click(removeBtn);
    await waitFor(() => expect(mocks.removeLearned).toHaveBeenCalledWith({ name: 'ts-unit' }));
  });

  it('已学技能为空 → 显示空态', async () => {
    mocks.listLearned.mockResolvedValue({ data: [] });
    renderSection();
    await waitFor(() => expect(screen.getByText('暂无已学技能')).toBeInTheDocument());
  });

  it('学习新技能 → 填写描述并点击学习', async () => {
    renderSection();
    const textarea = screen.getByPlaceholderText(
      '描述你想固化的能力（如：用 TypeScript 写单元测试时先建 describe 骨架）…',
    );
    await userEvent.type(textarea, '写 red-green 测试');
    // "学习新技能" 出现在标题与按钮 → 找按钮（type=button）
    const learnBtn = screen.getAllByText('学习新技能').find((el) => el.tagName === 'BUTTON');
    expect(learnBtn).toBeTruthy();
    await userEvent.click(learnBtn as HTMLElement);
    await waitFor(() =>
      expect(mocks.learn).toHaveBeenCalledWith({ rawInput: '写 red-green 测试' }),
    );
  });

  it('内置技能分组：全部 - 已学 = 内置（code-review）', async () => {
    renderSection();
    // ts-unit 已学（列表块）；code-review 非已学 → 内置组
    expect(await screen.findByText('code-review')).toBeInTheDocument();
  });
});
