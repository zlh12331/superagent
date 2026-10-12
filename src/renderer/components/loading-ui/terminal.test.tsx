import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { Terminal } from './terminal';

describe('Terminal（loading-ui）', () => {
  describe('可访问性契约', () => {
    it('role="status" 并提供本地化加载文案（读屏器可播报）', () => {
      render(<Terminal />);
      const status = screen.getByRole('status');
      expect(status).toBeDefined();
      expect(status.textContent).toContain(i18n.t('common.loading'));
    });

    it('提示符与光标对读屏器隐藏（纯装饰，不重复播报）', () => {
      const { container } = render(<Terminal prompt="$" />);
      const hidden = container.querySelectorAll('[aria-hidden="true"]');
      expect(hidden).toHaveLength(2);
      expect(hidden[0]?.textContent).toBe('$');
    });
  });

  describe('prompt 边界', () => {
    it('默认提示符为 ">"', () => {
      const { container } = render(<Terminal />);
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('>');
    });

    it('可覆盖提示符（TerminalPanel 传 "$"）', () => {
      const { container } = render(<Terminal prompt="$" />);
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('$');
    });

    it('空提示符合法（仅显示光标）', () => {
      const { container } = render(<Terminal prompt="" />);
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('');
      expect(container.querySelector('.loading-ui-terminal-cursor')).not.toBeNull();
    });
  });

  describe('props 透传', () => {
    it('className 与基础类合并（调用方控色）', () => {
      const { container } = render(<Terminal className="text-muted-foreground" />);
      const status = container.querySelector('[role="status"]');
      expect(status?.className).toContain('font-mono');
      expect(status?.className).toContain('inline-flex');
      expect(status?.className).toContain('text-muted-foreground');
    });

    it('style 透传（不吞掉调用方内联样式）', () => {
      const { container } = render(<Terminal style={{ fontSize: '20px' }} />);
      const status = container.querySelector<HTMLElement>('[role="status"]');
      expect(status?.style.fontSize).toBe('20px');
    });

    it('其余 span 属性透传（如 data-* / title）', () => {
      const { container } = render(<Terminal data-testid="tl" title="终端加载中" />);
      const status = container.querySelector('[role="status"]');
      expect(status?.getAttribute('data-testid')).toBe('tl');
      expect(status?.getAttribute('title')).toBe('终端加载中');
    });
  });

  describe('动画实现（回退防护）', () => {
    it('不在组件内内联 <style>（关键帧统一在 styles/*）', () => {
      const { container } = render(<Terminal />);
      expect(container.querySelector('style')).toBeNull();
    });

    it('光标用共享类承载动画（而非内联 animation style）', () => {
      const { container } = render(<Terminal />);
      const cursor = container.querySelector<HTMLElement>('.loading-ui-terminal-cursor');
      expect(cursor).not.toBeNull();
      expect(cursor?.getAttribute('style')).toBeNull();
    });
  });
});
