// src/renderer/test/smoke.test.tsx
// 渲染层测试基础设施冒烟测试
// ──────────────────────────────────────────────────────────────
// 职责：
// - 验证 vitest config + jsdom + setup 是否正常工作
// - 验证 @testing-library/react 可用
// - 验证 window.api / ResizeObserver / matchMedia polyfill 已生效
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

describe('renderer test infrastructure', () => {
  it('jsdom 环境可用（document 定义）', () => {
    expect(typeof document).toBe('object');
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
  });

  it('window.api 已被 setup 文件注入', () => {
    expect(window.api).toBeDefined();
    expect(window.api.terminal).toBeDefined();
    expect(window.api.git).toBeDefined();
  });

  it('ResizeObserver polyfill 已生效', () => {
    expect(window.ResizeObserver).toBeDefined();
    const observer = new ResizeObserver(() => {});
    expect(observer).toBeInstanceOf(ResizeObserver);
    observer.observe(document.body);
    observer.disconnect();
  });

  it('matchMedia polyfill 已生效', () => {
    expect(window.matchMedia).toBeDefined();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    expect(mql.matches).toBe(false);
  });

  it('IntersectionObserver polyfill 已生效', () => {
    expect(window.IntersectionObserver).toBeDefined();
    const observer = new IntersectionObserver(() => {});
    observer.observe(document.body);
    observer.disconnect();
  });
});
