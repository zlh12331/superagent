// markdown.test.tsx
// Markdown 渲染链单测：inline/block 分流 / shiki 高亮管线（成功·失败·跳过）/ 外链安全 / 复制
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../Markdown';

// shiki 高亮库 mock：codeToHtml 输出可断言的标记；可注入抛错验证降级
const codeToHtml = vi.fn(
  (code: string, opts: { lang: string; theme: string }) =>
    `<pre data-lang="${opts.lang}" data-theme="${opts.theme}">${code}</pre>`,
);
vi.mock('@/lib/highlight', () => ({
  getHighlighter: vi.fn(async () => ({ codeToHtml })),
  ensureLangLoaded: vi.fn(async () => {}),
  normalizeLang: vi.fn((lang: string) => lang),
}));

// useCopy / useTheme mock（jsdom 无剪贴板；主题需确定性）
const copySpy = vi.fn();
vi.mock('@/hooks/use-copy', () => ({
  useCopy: vi.fn(() => ({ copied: false, copy: copySpy })),
}));
vi.mock('@/providers/ThemeProvider', () => ({
  useTheme: vi.fn(() => ({ resolvedTheme: 'dark' })),
}));

describe('Markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正向：GFM 渲染（加粗 / 列表）', () => {
    const { container } = render(<Markdown content={'**加粗**与\n\n- 项目一'} />);
    expect(container.querySelector('strong')?.textContent).toBe('加粗');
    expect(container.querySelectorAll('li').length).toBe(1);
  });

  it('inline code：无 language-* className → <code class="inline">，不走 shiki', () => {
    const { container } = render(<Markdown content={'行内 `code` 片段'} />);
    const inline = container.querySelector('code.inline');
    expect(inline?.textContent).toBe('code');
    expect(codeToHtml).not.toHaveBeenCalled();
  });

  it('block code：异步 shiki 高亮（lang/theme 透传），完成后替换纯文本', async () => {
    const { container } = render(<Markdown content={'```ts\nconst a = 1\n```'} />);
    await waitFor(() => {
      expect(container.querySelector('pre[data-lang="ts"]')).not.toBeNull();
    });
    expect(codeToHtml).toHaveBeenCalledWith('const a = 1', {
      lang: 'ts',
      theme: 'github-dark',
    });
    expect(container.querySelector('pre[data-theme="github-dark"]')).not.toBeNull();
  });

  it('边界：highlight=false（流式）→ 跳过 shiki，代码以纯文本呈现', () => {
    const { container } = render(
      <Markdown content={'```ts\nconst a = 1\n```'} highlight={false} />,
    );
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(container.textContent).toContain('const a = 1');
  });

  it('边界：无语言标注围栏 → 现状按 inline code 呈现（language-* 正则不匹配）', () => {
    const { container } = render(<Markdown content={'```\nplain\n```'} />);
    // 围栏内容保留尾随换行（markdown 原文形态）
    expect(container.querySelector('code.inline')?.textContent?.trim()).toBe('plain');
    expect(codeToHtml).not.toHaveBeenCalled();
  });

  it('异常：codeToHtml 抛错 → 降级纯文本（不崩、不渲染 shiki 标记）', async () => {
    codeToHtml.mockImplementation(() => {
      throw new Error('shiki boom');
    });
    const { container } = render(<Markdown content={'```ts\nconst a = 1\n```'} />);
    await waitFor(() => {
      expect(container.textContent).toContain('const a = 1');
    });
    expect(container.querySelector('pre[data-lang]')).toBeNull();
  });

  it('安全：外链强制 target=_blank + rel=noopener noreferrer', () => {
    const { container } = render(<Markdown content={'[外站](https://example.com)'} />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });

  it('复制：代码块头栏复制按钮 → copy(代码原文)', async () => {
    render(<Markdown content={'```ts\nconst a = 1\n```'} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /复制/ })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    expect(copySpy).toHaveBeenCalledWith('const a = 1');
  });
});
