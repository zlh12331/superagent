// src/main/infra/file/file-service.test.ts
// FileService 单测 · 真实文件系统（重点：编码检测与转码）
// 无业务 mock：临时目录 + 真实文件驱动；GBK 文件用 iconv-lite 编码生成。

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@code-agent/shared/main';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFileService, type IFileService } from './file-service';

describe('FileService（真实文件系统）', () => {
  let dir: string;
  let svc: IFileService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-svc-test-'));
    svc = getFileService();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read：UTF-8 文件 → 内容正确且 encoding=utf-8', async () => {
    const file = join(dir, 'utf8.txt');
    // 无尾部换行：避免 split 产生尾部空行元素（既有语义：尾部 \n → 空行）
    await writeFile(file, '第一行\n第二行', 'utf-8');
    const res = await svc.read({ path: file, offset: undefined, limit: undefined });
    expect(res.content).toBe('第一行\n第二行');
    expect(res.encoding).toBe('utf-8');
    expect(res.totalLines).toBe(2);
  });

  it('read：GBK 编码文件 → 中文内容正确且 encoding 非 utf-8（Windows 场景）', async () => {
    const file = join(dir, 'gbk.txt');
    // 用 iconv-lite 编码生成 GBK 文件（模拟 Windows 旧编码文件）
    const gbkBuffer = iconv.encode('第一章 序章\n这是中文内容', 'gbk');
    await writeFile(file, gbkBuffer);
    const res = await svc.read({ path: file, offset: undefined, limit: undefined });
    expect(res.content).toBe('第一章 序章\n这是中文内容');
    expect(res.encoding).not.toBe('utf-8');
  });

  it('read：ASCII 文件 → 按 UTF-8 处理（chardet 返回 null）', async () => {
    const file = join(dir, 'ascii.txt');
    await writeFile(file, 'plain ascii content');
    const res = await svc.read({ path: file, offset: undefined, limit: undefined });
    expect(res.content).toBe('plain ascii content');
    expect(res.encoding).toBe('utf-8');
  });

  it('read：offset/limit 切片仍工作', async () => {
    const file = join(dir, 'slice.txt');
    await writeFile(file, 'l1\nl2\nl3\nl4', 'utf-8');
    const res = await svc.read({ path: file, offset: 1, limit: 2 });
    expect(res.content).toBe('l2\nl3');
    expect(res.totalLines).toBe(4);
  });

  it('read：文件不存在 → NOT_FOUND', async () => {
    await expect(
      svc.read({ path: join(dir, 'nope.txt'), offset: undefined, limit: undefined }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
