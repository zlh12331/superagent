// panel-notice.test.tsx
// 面板告警条单测：单行/多行排布 / 关闭回调 / 空行不渲染
// （合并自原 ChatPanel 内联的两条告警条：中断提示 + 历史回显缺口提示）
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n/config';

import { PanelNotice } from '../panel-notice';

const t = i18n.t.bind(i18n);

describe('PanelNotice', () => {
  it('正向（单行）：渲染文案 + 关闭按钮', () => {
    render(<PanelNotice lines={['上次回合已中断']} onDismiss={vi.fn()} />);
    expect(screen.getByText('上次回合已中断')).toBeDefined();
    expect(screen.getByRole('button', { name: t('common.close') })).toBeDefined();
  });

  it('正向（多行）：逐行渲染（历史回显缺口清单）', () => {
    render(<PanelNotice lines={['缺口一：仅文本', '缺口二：未知 part']} onDismiss={vi.fn()} />);
    expect(screen.getByText('缺口一：仅文本')).toBeDefined();
    expect(screen.getByText('缺口二：未知 part')).toBeDefined();
  });

  it('关闭：点击 × 触发 onDismiss', () => {
    const onDismiss = vi.fn();
    render(<PanelNotice lines={['提示']} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('边界：空行数组 → 不渲染（调用方无需自行判空）', () => {
    const { container } = render(<PanelNotice lines={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('边界：单行不产生多行列表包装（DOM 语义与合并前一致）', () => {
    const { container } = render(<PanelNotice lines={['单条']} onDismiss={vi.fn()} />);
    // 单行走 truncate 分支：直接文本节点，无 flex-col 列表容器
    expect(container.querySelector('.flex-col')).toBeNull();
    expect(container.querySelector('.truncate')?.textContent).toBe('单条');
  });

  it('无障碍：动态出现的提示带 role=status（读屏可播报）', () => {
    render(<PanelNotice lines={['会话加载后才判定出的缺口']} onDismiss={vi.fn()} />);
    // 提示是会话加载后异步出现，无 live 语义时读屏不会主动播报
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('边界：重复文案行仍渲染（以行序为 key，不因内容重复告警/丢行）', () => {
    const { container } = render(<PanelNotice lines={['同一条', '同一条']} onDismiss={vi.fn()} />);
    expect(container.querySelectorAll('.flex-col > span')).toHaveLength(2);
  });
});
