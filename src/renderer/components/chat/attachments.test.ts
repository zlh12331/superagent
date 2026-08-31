// src/renderer/components/chat/attachments.test.ts
// 附件内容拼接回归（file:read 拼装 + 失败降级标注）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attachmentName, buildTextWithAttachments, type ChatAttachment } from './attachments';

function stubFileRead(impl: (path: string) => unknown): void {
  window.api.file = {
    read: vi.fn(async (input: { path: string }) => impl(input.path)),
  } as never;
}

describe('attachmentName', () => {
  it('win32/posix 分隔符均取 basename', () => {
    expect(attachmentName('C:\\repo\\src\\a.ts')).toBe('a.ts');
    expect(attachmentName('/repo/src/a.ts')).toBe('a.ts');
  });

  it('无分隔符原样返回', () => {
    expect(attachmentName('a.ts')).toBe('a.ts');
  });
});

describe('buildTextWithAttachments', () => {
  beforeEach(() => {
    window.api.file = {} as never;
  });

  it('无附件 → 原样返回', async () => {
    const text = await buildTextWithAttachments('hello', []);
    expect(text).toBe('hello');
  });

  it('附件读取成功 → 文件名 + 代码块拼接', async () => {
    stubFileRead(() => ({ data: { content: 'const x = 1;\n'.repeat(10) } }));
    const text = await buildTextWithAttachments('hello', [{ path: 'C:\\r\\a.ts', name: 'a.ts' }]);
    expect(text).toContain('hello');
    expect(text).toContain('[附件: a.ts]');
    expect(text).toContain('```');
    expect(text).toContain('const x = 1;');
  });

  it('附件内容超上限截断（4000 字符）', async () => {
    stubFileRead(() => ({ data: { content: 'x'.repeat(5000) } }));
    const text = await buildTextWithAttachments('m', [{ path: '/r/big', name: 'big' }]);
    const body = (text.split('```')[1] ?? '').trim();
    expect(body.length).toBe(4000);
  });

  it('IPC error 响应 → 降级为文件名标注，不阻断', async () => {
    stubFileRead(() => ({ error: { code: 'FILE_NOT_FOUND', message: 'missing' } }));
    const text = await buildTextWithAttachments('m', [{ path: '/r/gone', name: 'gone' }]);
    expect(text).toBe('m\n\n[附件: gone]（内容读取失败）');
  });

  it('read 抛异常（二进制/权限）→ 同样降级标注', async () => {
    stubFileRead(() => {
      throw new Error('binary');
    });
    const text = await buildTextWithAttachments('m', [{ path: '/r/bin', name: 'bin' }]);
    expect(text).toContain('[附件: bin]（内容读取失败）');
  });

  it('多附件逐个拼接（第一个失败不影响第二个）', async () => {
    window.api.file = {
      read: vi.fn(async (input: { path: string }) =>
        input.path === '/r/bad'
          ? { error: { code: 'X', message: 'e' } }
          : { data: { content: 'ok-content' } },
      ),
    } as never;
    const atts: readonly ChatAttachment[] = [
      { path: '/r/bad', name: 'bad' },
      { path: '/r/good', name: 'good' },
    ];
    const text = await buildTextWithAttachments('m', atts);
    expect(text).toContain('[附件: bad]（内容读取失败）');
    expect(text).toContain('ok-content');
  });

  it('浏览器模式（window.api 缺失）→ 原样返回', async () => {
    const w = window as unknown as { api?: unknown };
    const saved = w.api;
    w.api = undefined;
    const text = await buildTextWithAttachments('m', [{ path: '/r/a', name: 'a' }]);
    expect(text).toBe('m');
    w.api = saved;
  });
});
