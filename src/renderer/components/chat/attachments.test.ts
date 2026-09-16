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
  /** 测试用中文文案（生产由调用方传 i18n 工厂） */
  const label = {
    attached: (name: string) => `[附件: ${name}]`,
    readFailed: (name: string) => `[附件: ${name}]（内容读取失败）`,
    truncated: (chars: number) => `\n…[截断，原始 ${chars} 字符]`,
  };

  beforeEach(() => {
    window.api.file = {} as never;
  });

  it('无附件 → 原样返回', async () => {
    const text = await buildTextWithAttachments('hello', [], label);
    expect(text).toBe('hello');
  });

  it('附件读取成功 → 文件名 + 代码块拼接', async () => {
    stubFileRead(() => ({ data: { content: 'const x = 1;\n'.repeat(10) } }));
    const text = await buildTextWithAttachments(
      'hello',
      [{ path: 'C:\\r\\a.ts', name: 'a.ts' }],
      label,
    );
    expect(text).toContain('hello');
    expect(text).toContain('[附件: a.ts]');
    expect(text).toContain('```');
    expect(text).toContain('const x = 1;');
  });

  it('附件内容超上限截断（4000 字符）+ 显式截断标注', async () => {
    stubFileRead(() => ({ data: { content: 'x'.repeat(5000) } }));
    const text = await buildTextWithAttachments('m', [{ path: '/r/big', name: 'big' }], label);
    const body = (text.split('```')[1] ?? '').trim();
    // 正文 4000 字符 + 截断标注行（此前静默截断，模型/用户会误以为拿到完整文件）
    expect(body).toContain('x'.repeat(4000));
    expect(body).toContain('原始 5000 字符');
  });

  it('边界：内容恰好等于上限 → 不标截断', async () => {
    stubFileRead(() => ({ data: { content: 'y'.repeat(4000) } }));
    const text = await buildTextWithAttachments('m', [{ path: '/r/exact', name: 'exact' }], label);
    expect(text).not.toContain('截断');
    expect(text).toContain('y'.repeat(4000));
  });

  it('IPC error 响应 → 降级为文件名标注，不阻断', async () => {
    stubFileRead(() => ({ error: { code: 'FILE_NOT_FOUND', message: 'missing' } }));
    const text = await buildTextWithAttachments('m', [{ path: '/r/gone', name: 'gone' }], label);
    expect(text).toBe('m\n\n[附件: gone]（内容读取失败）');
  });

  it('read 抛异常（二进制/权限）→ 同样降级标注', async () => {
    stubFileRead(() => {
      throw new Error('binary');
    });
    const text = await buildTextWithAttachments('m', [{ path: '/r/bin', name: 'bin' }], label);
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
    const text = await buildTextWithAttachments('m', atts, label);
    expect(text).toContain('[附件: bad]（内容读取失败）');
    expect(text).toContain('ok-content');
  });

  it('浏览器模式（window.api 缺失）→ 原样返回', async () => {
    const w = window as unknown as { api?: unknown };
    const saved = w.api;
    w.api = undefined;
    const text = await buildTextWithAttachments('m', [{ path: '/r/a', name: 'a' }], label);
    expect(text).toBe('m');
    w.api = saved;
  });
});
