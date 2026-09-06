// src/main/infra/ai/tools/web-fetch.tool.test.ts
// web_fetch 工具单测：协议白名单 / HTTP 错误 / 空正文 / 截断 / 失败降级（mock 全局 fetch）

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from './tool';
import { createWebFetchTool } from './web-fetch.tool';

const ctx = { workingDir: '/tmp' } as unknown as ToolContext;

describe('web_fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功抓取：去标签正文 + 来源行', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html><body><h1>标题</h1><p>正文内容</p></body></html>',
      })),
    );
    const result = await createWebFetchTool().execute({ url: 'https://example.com/doc' }, ctx);
    expect(result.title).toBe('web_fetch: example.com');
    expect(result.output).toContain('来源：https://example.com/doc');
    expect(result.output).toContain('正文内容');
    expect(result.output).not.toContain('<h1>');
  });

  it('maxChars 截断并标注', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'x'.repeat(1000),
      })),
    );
    const result = await createWebFetchTool().execute(
      { url: 'https://example.com', maxChars: 100 },
      ctx,
    );
    expect(result.output).toContain('…（已截断）');
  });

  it('非 2xx → HTTP 错误提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
      })),
    );
    const result = await createWebFetchTool().execute({ url: 'https://example.com/missing' }, ctx);
    expect(result.title).toBe('web_fetch 失败');
    expect(result.output).toContain('HTTP 404');
  });

  it('无效 URL → 无效 URL 提示（不发起请求）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await createWebFetchTool().execute({ url: 'not a url' }, ctx);
    expect(result.title).toBe('web_fetch 失败');
    expect(result.output).toContain('无效的 URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非 http/https 协议 → 不支持的协议', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await createWebFetchTool().execute({ url: 'file:///etc/passwd' }, ctx);
    expect(result.output).toContain('仅 http/https');
  });

  it('网络失败（fetch 抛错）→ 抓取失败提示，不抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await createWebFetchTool().execute({ url: 'https://example.com' }, ctx);
    expect(result.title).toBe('web_fetch 失败');
    expect(result.output).toContain('抓取失败');
  });

  it('页面无可提取正文 → 明确提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '   ' })),
    );
    const result = await createWebFetchTool().execute({ url: 'https://example.com' }, ctx);
    expect(result.output).toContain('页面无可提取的正文文本');
  });
});
