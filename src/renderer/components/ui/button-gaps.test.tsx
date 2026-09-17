// src/renderer/components/ui/__tests__/button-gaps.test.tsx
// ui/button 批次8 缺口补全：变体/尺寸/asChild/禁用/className 合并
//
// 测试要点：默认渲染与基础类、6 变体类名、4 尺寸类名、disabled 透传、
// asChild Slot 渲染子元素、className 合并

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button, buttonVariants } from './button';

describe('ui/button 批次8 缺口补全', () => {
  it('默认渲染 button 元素 + data-slot + 基础类', () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn.getAttribute('data-slot')).toBe('button');
    expect(btn.className).toContain('inline-flex');
  });

  it('6 种 variant：类名正确映射', () => {
    expect(buttonVariants({ variant: 'default' })).toContain('bg-primary');
    expect(buttonVariants({ variant: 'destructive' })).toContain('bg-destructive');
    expect(buttonVariants({ variant: 'outline' })).toContain('border-input');
    expect(buttonVariants({ variant: 'secondary' })).toContain('bg-secondary');
    expect(buttonVariants({ variant: 'ghost' })).toContain('hover:bg-accent');
    expect(buttonVariants({ variant: 'link' })).toContain('underline-offset-4');
  });

  it('4 种 size：类名正确映射', () => {
    expect(buttonVariants({ size: 'default' })).toContain('h-9');
    expect(buttonVariants({ size: 'sm' })).toContain('h-8');
    expect(buttonVariants({ size: 'lg' })).toContain('h-10');
    // icon 尺寸用 size-9（宽高相等语义，样式铁律⑤）
    expect(buttonVariants({ size: 'icon' })).toContain('size-9');
  });

  it('disabled：透传到原生 button', () => {
    render(
      <Button disabled>
        <span>禁用</span>
      </Button>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('asChild：Slot 渲染子元素（a 标签继承按钮语义）', () => {
    render(
      <Button asChild variant="outline">
        <a href="/settings">链接式按钮</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: '链接式按钮' });
    expect(link.getAttribute('data-slot')).toBe('button');
    expect(link.className).toContain('border-input');
  });

  it('className 合并：自定义类与变体类共存', () => {
    render(<Button className="custom-class">自定义</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('custom-class');
    expect(btn.className).toContain('bg-primary');
  });
});
