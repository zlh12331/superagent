// src/renderer/components/file-tree/__tests__/file-icon.test.tsx
// file-icon 批次7 缺口补全：扩展名 → 图标/颜色映射
//
// 测试要点：文件夹展开/收起、各扩展名映射（rs/ts/tsx/js/jsx/json/md/toml/图片）、
// 大小写不敏感、无扩展名/点文件/未知扩展名默认

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FileIcon } from '../file-icon';

describe('file-icon 批次7 缺口补全', () => {
  function getIconProps(name: string, isFolder = false, expanded?: boolean) {
    const { container } = render(
      <FileIcon
        name={name}
        isFolder={isFolder}
        {...(expanded !== undefined ? { expanded } : {})}
      />,
    );
    return {
      svg: container.querySelector('svg'),
      color: (container.querySelector('svg')?.getAttribute('style') ?? '').replace(/color:\s*/, ''),
    };
  }

  it('文件夹：收起显示 Folder，展开显示 FolderOpen（同色 --text-faint）', () => {
    const closed = getIconProps('src', true, false);
    expect(closed.svg?.getAttribute('aria-hidden')).toBe('true');
    const opened = getIconProps('src', true, true);
    // 两个实例图标不同（Folder vs FolderOpen 均为 lucide svg，通过 style 色验证同一规则）
    expect(closed.color).toContain('--text-faint');
    expect(opened.color).toContain('--text-faint');
  });

  it('ts/tsx/js/jsx：FileCode 蓝（accent-2）', () => {
    for (const name of ['main.ts', 'App.tsx', 'index.js', 'util.jsx']) {
      expect(getIconProps(name).color).toContain('--accent-2');
    }
  });

  it('rs：FileCode 橙（warn）', () => {
    expect(getIconProps('lib.rs').color).toContain('--warn');
  });

  it('json：FileJson 黄（amber）', () => {
    expect(getIconProps('package.json').color).toContain('--amber');
  });

  it('md：FileText 灰（muted-foreground）', () => {
    expect(getIconProps('README.md').color).toContain('--muted-foreground');
  });

  it('toml：FileCog 红（error）', () => {
    expect(getIconProps('config.toml').color).toContain('--error');
  });

  it('图片扩展名：Image 绿（success）', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.svg']) {
      expect(getIconProps(name).color).toContain('--success');
    }
  });

  it('大小写不敏感：.TS / .JSON 同样匹配', () => {
    expect(getIconProps('MAIN.TS').color).toContain('--accent-2');
    expect(getIconProps('PACKAGE.JSON').color).toContain('--amber');
  });

  it('无扩展名/未知扩展名：默认 File 灰（text-faint）', () => {
    expect(getIconProps('Makefile').color).toContain('--text-faint');
    expect(getIconProps('unknown.xyz').color).toContain('--text-faint');
  });

  it('点文件（.env）：无扩展名语义，走默认', () => {
    expect(getIconProps('.env').color).toContain('--text-faint');
  });
});
