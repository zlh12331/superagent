// src/renderer/components/loading-ui/__tests__/terminal.test.tsx
// Terminal 加载指示器测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 此前仅经 TerminalPanel 间接覆盖（无独立断言），故这些行为没有被锁定：
// 1. 可访问性契约：role="status" + sr-only **本地化** 文案；提示符/光标对读屏器隐藏
// 2. 动画不内联 <style>（改用 globals.css 的 .loading-ui-terminal-cursor）
//    —— 防止回退为组件内私有 keyframe（渲染层唯一内联 style 的历史问题）
// 3. props 透传：prompt 默认值与覆盖、className 合并、style 透传
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { Terminal } from '../terminal';

describe('Terminal（loading-ui）', () => {
  describe('可访问性契约', () => {
    it('role="status" 并提供本地化加载文案（读屏器可播报）', () => {
      render(<Terminal />);
      const status = screen.getByRole('status');
      expect(status).toBeDefined();
      // sr-only 文案走 i18n，而非硬编码 'Loading'
      expect(status.textContent).toContain(i18n.t('common.loading'));
    });

    it('提示符与光标对读屏器隐藏（纯装饰，不重复播报）', () => {
      const { container } = render(<Terminal prompt="$" />);
      const hidden = container.querySelectorAll('[aria-hidden="true"]');
      // 提示符 + 光标块，共两个装饰元素
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
      // 光标仍在
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
    it('不在组件内内联 <style>（关键帧统一在 globals.css）', () => {
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
