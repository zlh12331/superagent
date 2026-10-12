import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SectionTitle, SegControl, SettingRow, ToggleRow } from './settings-controls';

const OPTIONS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
];

describe('SegControl', () => {
  it('正向：点击未选中项 → onChange(该项 value)', async () => {
    const onChange = vi.fn();
    render(<SegControl value="1" onChange={onChange} options={OPTIONS} />);

    const items = screen.getAllByRole('radio');
    await userEvent.click(items[2] as HTMLElement);

    expect(onChange).toHaveBeenCalledWith('3');
  });

  it('回归：点击**已选中**项 → 不回调（Radix 反选会传空串，曾被 Number("") 写成 0）', async () => {
    const onChange = vi.fn();
    render(<SegControl value="2" onChange={onChange} options={OPTIONS} />);

    const items = screen.getAllByRole('radio');
    await userEvent.click(items[1] as HTMLElement);

    expect(onChange).not.toHaveBeenCalled();
    expect(onChange.mock.calls.every((call) => call[0] !== '')).toBe(true);
  });

  it('异常：连续点击同一已选项仍不产生空串回调', async () => {
    const onChange = vi.fn();
    render(<SegControl value="1" onChange={onChange} options={OPTIONS} />);

    const items = screen.getAllByRole('radio');
    await userEvent.click(items[0] as HTMLElement);
    await userEvent.click(items[0] as HTMLElement);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('边界：选项为空数组时不崩溃', () => {
    const { container } = render(<SegControl value="" onChange={vi.fn()} options={[]} />);
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(0);
  });

  it('可访问性：使用 RadioGroup 语义（roving tabindex，非手写 aria-pressed）', () => {
    render(<SegControl value="1" onChange={vi.fn()} options={OPTIONS} />);
    expect(screen.getByRole('radiogroup')).toBeDefined();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getAllByRole('radio')[0]?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('SettingRow', () => {
  it('渲染 label 与右侧控件；无 description 时不渲染描述行', () => {
    const { container } = render(
      <SettingRow label="标签">
        <span data-testid="ctrl">控件</span>
      </SettingRow>,
    );
    expect(screen.getByText('标签')).toBeDefined();
    expect(screen.getByTestId('ctrl')).toBeDefined();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('提供 description 时渲染为次级说明', () => {
    render(
      <SettingRow label="标签" description="说明文字">
        <span>控件</span>
      </SettingRow>,
    );
    expect(screen.getByText('说明文字')).toBeDefined();
  });
});

describe('ToggleRow', () => {
  it('开关状态与 aria-label 来自 name', () => {
    render(<ToggleRow name="测试开关" checked={false} onChange={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: '测试开关' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('点击开关 → onChange(true)', async () => {
    const onChange = vi.fn();
    render(<ToggleRow name="测试开关" checked={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole('switch', { name: '测试开关' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('边界：description 透传（不传时不渲染）', () => {
    const { container } = render(<ToggleRow name="开关" checked onChange={vi.fn()} />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});

describe('SectionTitle', () => {
  it('渲染为 h4 并附加自定义类名', () => {
    const { container } = render(<SectionTitle className="custom-cls">标题</SectionTitle>);
    const h4 = container.querySelector('h4');
    expect(h4?.textContent).toBe('标题');
    expect(h4?.className).toContain('custom-cls');
  });
});
