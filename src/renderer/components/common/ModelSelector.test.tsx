// src/renderer/components/common/ModelSelector.test.tsx
// ModelSelector 组件逻辑回归（清单渲染 / 选择回调 / 受控开关 / 键盘导航）
// ──────────────────────────────────────────────
// 覆盖动机：组件行覆盖 34%/分支 23%——去硬编码模型选择器（models:list 单一真源）
// 的分组渲染、未知模型回退、受控/非受控双模式、roving focus 键盘导航均无单测。
// useModelsQuery 以 vi.mock 注入固定清单，避免依赖 TanStack Query 异步时序。
// ──────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ModelSelector } from './ModelSelector';

const mockState = vi.hoisted(() => ({
  models: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat', providerKind: 'deepseek' },
    { id: 'gpt-4o', label: 'GPT-4o', providerKind: 'openai' },
  ] as Array<{ id: string; label: string; providerKind: string }>,
}));

vi.mock('@/hooks/use-models', () => ({
  useModelsQuery: (): { data: { models: typeof mockState.models } } => ({
    data: { models: mockState.models },
  }),
}));

type Props = Parameters<typeof ModelSelector>[0];

function renderSelector(overrides: Partial<Props> = {}): ReturnType<typeof render> {
  return render(
    <ModelSelector
      provider="deepseek"
      model="deepseek-chat"
      onProviderChange={vi.fn()}
      onModelChange={vi.fn()}
      {...overrides}
    />,
  );
}

function openButton(): HTMLElement {
  return screen.getByLabelText(i18n.t('common.selectModel'));
}

describe('ModelSelector', () => {
  beforeEach(() => {
    mockState.models = [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', providerKind: 'deepseek' },
      { id: 'gpt-4o', label: 'GPT-4o', providerKind: 'openai' },
    ];
  });

  it('渲染当前选中模型（provider + 展示名）', () => {
    renderSelector();
    expect(openButton().textContent).toContain('deepseek');
    expect(openButton().textContent).toContain('DeepSeek Chat');
  });

  it('清单中不存在的模型 id → 按钮回退显示原始 id', () => {
    renderSelector({ model: 'custom-runtime-model' });
    expect(openButton().textContent).toContain('custom-runtime-model');
  });

  it('空清单 → 显示未配置占位；打开后显示空态提示', () => {
    mockState.models = [];
    renderSelector();
    expect(openButton().textContent).toContain(i18n.t('common.noModelConfigured'));

    fireEvent.click(openButton());
    expect(screen.getByText(i18n.t('common.noModels'))).toBeInTheDocument();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('打开下拉 → 按 providerKind 分组；选中项带 active 类', () => {
    const { container } = renderSelector();
    fireEvent.click(openButton());

    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    // 分组头：kind 原文 + 首字母大写图标
    expect(menu.textContent).toContain('deepseek');
    expect(menu.textContent).toContain('openai');
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    expect(container.querySelector('.model-item.active')?.textContent).toBe('DeepSeek Chat');
  });

  it('点击模型 → 回调 provider/model 并关闭菜单（非受控模式）', () => {
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    renderSelector({ onProviderChange, onModelChange });

    fireEvent.click(openButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'GPT-4o' }));

    expect(onProviderChange).toHaveBeenCalledWith('openai');
    expect(onModelChange).toHaveBeenCalledWith('gpt-4o');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(openButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('disabled → 点击不打开', () => {
    renderSelector({ disabled: true });
    fireEvent.click(openButton());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape → 关闭菜单', () => {
    renderSelector();
    fireEvent.click(openButton());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点击外部（mousedown 不在容器内）→ 关闭菜单', () => {
    renderSelector();
    fireEvent.click(openButton());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('键盘 roving focus：打开聚焦首项，ArrowDown/ArrowUp 循环，Home/End 跳首尾', () => {
    renderSelector();
    fireEvent.click(openButton());
    const items = screen.getAllByRole('menuitem');

    // 打开时 effect 聚焦选中项（deepseek-chat active）
    expect(document.activeElement).toBe(items[0]);

    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]); // 循环回首
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]); // 循环到尾
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('受控模式：开关走 onOpenChange，选择后不改内部状态', () => {
    const onOpenChange = vi.fn();
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    const { rerender } = render(
      <ModelSelector
        provider="deepseek"
        model="deepseek-chat"
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'GPT-4o' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onProviderChange).toHaveBeenCalledWith('openai');
    expect(onModelChange).toHaveBeenCalledWith('gpt-4o');

    // 受控 open 仍为 true → 菜单保持打开（父组件决定何时关闭）
    rerender(
      <ModelSelector
        provider="deepseek"
        model="deepseek-chat"
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        open={true}
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
