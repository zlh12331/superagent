// src/renderer/components/file-tree/__tests__/file-icon.test.tsx
// file-icon 单测：扩展名 → 图标 + 配色映射（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 重写背景（2026-09 file-tree 审计）：原测试对文件夹只用 style 颜色断言，
// 注释自认「两个实例图标不同……通过 style 色验证同一规则」——即**没有**断言
// 图标本身，Folder/FolderOpen 互换也照样通过，是假绿。
// 现按 lucide 渲染出的类名（.lucide-*）直接断言图标身份（同类断言先例：
// components/layout/__tests__/layout-gaps.test.tsx 的 .lucide-sun/.lucide-moon）。
//
// 另：isFolder / expanded 两个 prop 已随死代码清理移除（生产零使用，
// 唯一调用点固定 isFolder={false}），故不再有文件夹用例。
// ──────────────────────────────────────────────────────────────

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FileIcon } from '../file-icon';

/** 渲染并取出 svg 的图标类名（lucide 会把图标名渲染成 .lucide-<kebab-name>） */
function renderIcon(name: string): { classes: string; color: string } {
  const { container } = render(<FileIcon name={name} />);
  const svg = container.querySelector('svg');
  return {
    classes: svg?.getAttribute('class') ?? '',
    color: svg?.getAttribute('style') ?? '',
  };
}

describe('FileIcon · 扩展名映射', () => {
  it('rs：FileCode 图标 + 橙（warn）', () => {
    const { classes, color } = renderIcon('lib.rs');
    expect(classes).toContain('lucide-file-code');
    expect(color).toContain('--warn');
  });

  it('ts / tsx / js / jsx：FileCode 图标 + 蓝（accent-2）', () => {
    for (const name of ['main.ts', 'App.tsx', 'index.js', 'util.jsx']) {
      const { classes, color } = renderIcon(name);
      expect(classes, name).toContain('lucide-file-code');
      expect(color, name).toContain('--accent-2');
    }
  });

  it('json：FileJson 图标 + 黄（amber）', () => {
    const { classes, color } = renderIcon('package.json');
    // lucide 当前把 FileJson 渲染为 .lucide-file-braces（图标名与类名不一致，
    // 故此处按实测类名断言；换图标时本用例会失败并要求同步核实）
    expect(classes).toContain('lucide-file-braces');
    expect(color).toContain('--amber');
  });

  it('md：FileText 图标 + 灰（muted-foreground）', () => {
    const { classes, color } = renderIcon('README.md');
    expect(classes).toContain('lucide-file-text');
    expect(color).toContain('--muted-foreground');
  });

  it('toml：FileCog 图标 + 红（error）', () => {
    const { classes, color } = renderIcon('config.toml');
    expect(classes).toContain('lucide-file-cog');
    expect(color).toContain('--error');
  });

  it('图片类：Image 图标 + 绿（success）', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.svg']) {
      const { classes, color } = renderIcon(name);
      expect(classes, name).toContain('lucide-image');
      expect(color, name).toContain('--success');
    }
  });

  it('默认：File 图标 + 灰（text-faint）——无扩展名与未知扩展名同判', () => {
    for (const name of ['Makefile', 'unknown.xyz', '.env', '']) {
      const { classes, color } = renderIcon(name);
      expect(classes, name).toContain('lucide-file');
      // 不能命中其它类型的图标（lucide-file-code 也含 lucide-file 前缀，故反查排除）
      expect(classes, name).not.toContain('lucide-file-code');
      expect(color, name).toContain('--text-faint');
    }
  });
});

describe('FileIcon · 边界与异常', () => {
  it('大小写不敏感：.TS / .JSON / .PNG 同样命中', () => {
    expect(renderIcon('MAIN.TS').color).toContain('--accent-2');
    expect(renderIcon('PACKAGE.JSON').classes).toContain('lucide-file-braces');
    expect(renderIcon('SHOT.PNG').classes).toContain('lucide-image');
  });

  it('多点文件名：取最后一个点之后（a.test.ts → ts 而非 test）', () => {
    const { classes, color } = renderIcon('a.test.ts');
    expect(classes).toContain('lucide-file-code');
    expect(color).toContain('--accent-2');
  });

  it('点文件（.env）：点后内容被当作扩展名 → 未命中映射走默认', () => {
    const { color } = renderIcon('.env');
    expect(color).toContain('--text-faint');
  });

  it('尾点（a.）：扩展名为空 → 默认图标', () => {
    const { classes, color } = renderIcon('a.');
    expect(classes).toContain('lucide-file');
    expect(classes).not.toContain('lucide-file-code');
    expect(color).toContain('--text-faint');
  });

  it('目录名含点但文件名无扩展名：不误判中间的点', () => {
    // 本组件的入参是「名称」不是路径，此用例锁定「只看最后一段的点」的行为
    const { color } = renderIcon('v1.2');
    expect(color).toContain('--text-faint');
  });

  it('可访问性：图标为纯装饰（aria-hidden），尺寸默认 13', () => {
    const { container } = render(<FileIcon name="a.ts" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('13');
    expect(svg?.getAttribute('height')).toBe('13');
  });

  it('size 可覆盖：显式传入生效', () => {
    const { container } = render(<FileIcon name="a.ts" size={20} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
  });
});
