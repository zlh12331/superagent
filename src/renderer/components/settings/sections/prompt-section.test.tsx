// src/renderer/components/settings/sections/prompt-section.test.tsx
// PromptSection 单测：系统提示词编辑（编辑/保存/清空/取消）
// 数据源：useSettingsStore（zustand persist，直接 setState 注入）；i18n 已加载 zh-CN（中文断言）。
// 业务交互保持真实实现断言。

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSettingsStore } from '@/stores/persistent/settings-store';

import { PromptSection } from './prompt-section';

function renderSection(open = true): void {
  render(<PromptSection open={open} />);
}

describe('PromptSection', () => {
  /** 用一个 systemPrompt 覆盖整 ai 对象（zustand 浅合并需整体替换，补全字段） */
  const aiWith = (systemPrompt: string): Record<string, unknown> => ({
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4-flash',
    temperature: 0.7,
    systemPrompt,
    thinking: 'high',
  });

  beforeEach(() => {
    useSettingsStore.setState({ ai: { ...useSettingsStore.getState().ai, systemPrompt: '' } });
  });

  it('open 时展示默认提示文案（未设置）', () => {
    renderSection();
    expect(screen.getByText('（使用默认 system prompt）')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
  });

  it('点击设置 → 进入编辑态，加载已持久化提示词到 textarea', async () => {
    useSettingsStore.setState({ ai: aiWith('预置提示词') } as never);
    renderSection();
    await userEvent.click(screen.getByText('修改'));
    const textarea = screen.getByPlaceholderText(
      '例如：你是一个专注于 TypeScript 代码审查的助手，请使用中文回答...',
    );
    expect(screen.getByText('保存')).toBeInTheDocument();
    expect(textarea).toHaveValue('预置提示词');
  });

  it('编辑后保存 → updateAi 写 store 并退出编辑态', async () => {
    renderSection();
    await userEvent.click(screen.getByText('设置'));
    const textarea = screen.getByPlaceholderText(
      '例如：你是一个专注于 TypeScript 代码审查的助手，请使用中文回答...',
    );
    await userEvent.type(textarea, '自定义提示');
    await userEvent.click(screen.getByText('保存'));
    expect(useSettingsStore.getState().ai.systemPrompt).toBe('自定义提示');
    expect(screen.getByText('自定义提示')).toBeInTheDocument();
  });

  it('清空 → updateAi 写空串，回到未设置态', async () => {
    useSettingsStore.setState({ ai: aiWith('旧内容') } as never);
    renderSection();
    await userEvent.click(screen.getByText('修改'));
    const textarea = screen.getByPlaceholderText(
      '例如：你是一个专注于 TypeScript 代码审查的助手，请使用中文回答...',
    );
    await userEvent.type(textarea, 'x');
    await userEvent.click(screen.getByText('清空'));
    expect(useSettingsStore.getState().ai.systemPrompt).toBe('');
    expect(screen.getByText('（使用默认 system prompt）')).toBeInTheDocument();
  });

  it('取消 → 丢弃草稿回到展示态', async () => {
    useSettingsStore.setState({ ai: aiWith('旧内容') } as never);
    renderSection();
    await userEvent.click(screen.getByText('修改'));
    await userEvent.type(
      screen.getByPlaceholderText(
        '例如：你是一个专注于 TypeScript 代码审查的助手，请使用中文回答...',
      ),
      '草稿',
    );
    await userEvent.click(screen.getByText('取消'));
    expect(screen.getByText('旧内容')).toBeInTheDocument();
    expect(useSettingsStore.getState().ai.systemPrompt).toBe('旧内容');
  });
});
