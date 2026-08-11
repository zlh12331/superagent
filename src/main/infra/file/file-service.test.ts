// src/main/infra/file/file-service.test.ts
// FileService 单测 · 真实文件系统（重点：编码检测与转码）
// 无业务 mock：临时目录 + 真实文件驱动；GBK 文件用 iconv-lite 编码生成。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('FileService.write（写入三件套）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-write-'));
    svc = getFileService();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正向：新建文件 → bytesWritten 正确且内容可读', async () => {
    const res = await svc.write({
      path: join(dir, 'a.txt'),
      content: '你好 world',
      append: false,
      createDirs: false,
    });
    expect(res.bytesWritten).toBe(Buffer.byteLength('你好 world', 'utf-8'));
    const read = await svc.read({ path: join(dir, 'a.txt'), offset: undefined, limit: undefined });
    expect(read.content).toBe('你好 world');
  });

  it('正向：append=true 追加（文件不存在时创建）', async () => {
    await svc.write({
      path: join(dir, 'log.txt'),
      content: 'line1\n',
      append: true,
      createDirs: false,
    });
    await svc.write({
      path: join(dir, 'log.txt'),
      content: 'line2\n',
      append: true,
      createDirs: false,
    });
    const read = await svc.read({
      path: join(dir, 'log.txt'),
      offset: undefined,
      limit: undefined,
    });
    expect(read.content).toBe('line1\nline2\n');
  });

  it('正向：createDirs=true 自动创建父目录', async () => {
    await svc.write({
      path: join(dir, 'nested', 'deep', 'f.txt'),
      content: 'x',
      append: false,
      createDirs: true,
    });
    expect(
      (
        await svc.read({
          path: join(dir, 'nested', 'deep', 'f.txt'),
          offset: undefined,
          limit: undefined,
        })
      ).content,
    ).toBe('x');
  });

  it('边界：append=false 覆盖已有内容', async () => {
    await svc.write({ path: join(dir, 'o.txt'), content: 'old', append: false, createDirs: false });
    await svc.write({ path: join(dir, 'o.txt'), content: 'new', append: false, createDirs: false });
    const read = await svc.read({ path: join(dir, 'o.txt'), offset: undefined, limit: undefined });
    expect(read.content).toBe('new');
  });

  it('异常：相对路径 → INVALID_INPUT', async () => {
    await expect(
      svc.write({ path: 'relative.txt', content: 'x', append: false, createDirs: false }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });

  it('异常：空路径 → INVALID_INPUT', async () => {
    await expect(
      svc.write({ path: '', content: 'x', append: false, createDirs: false }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });

  it('异常：父目录不存在且 createDirs=false → 抛错（非静默失败）', async () => {
    await expect(
      svc.write({
        path: join(dir, 'no-dir', 'f.txt'),
        content: 'x',
        append: false,
        createDirs: false,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('FileService.list（目录列举三件套）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-list-'));
    svc = getFileService();
    await writeFile(join(dir, 'a.ts'), 'a');
    await writeFile(join(dir, '.hidden'), 'h');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'b.ts'), 'b');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正向：depth=1 仅列直接子项', async () => {
    const res = await svc.list({ path: dir, depth: 1, includeHidden: false });
    const names = res.entries.map((e) => e.name);
    expect(names).toContain('a.ts');
    expect(names).toContain('sub');
    expect(names).not.toContain('b.ts'); // 子目录内容不递归
  });

  it('正向：depth=2 递归包含子目录文件', async () => {
    const res = await svc.list({ path: dir, depth: 2, includeHidden: false });
    expect(res.entries.map((e) => e.name)).toContain('b.ts');
  });

  it('边界：includeHidden=false 跳过点开头', async () => {
    const res = await svc.list({ path: dir, depth: 1, includeHidden: false });
    expect(res.entries.map((e) => e.name)).not.toContain('.hidden');
  });

  it('边界：includeHidden=true 包含隐藏', async () => {
    const res = await svc.list({ path: dir, depth: 1, includeHidden: true });
    expect(res.entries.map((e) => e.name)).toContain('.hidden');
  });

  it('异常：路径不存在 → 抛错', async () => {
    await expect(
      svc.list({ path: join(dir, 'missing'), depth: 1, includeHidden: false }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('FileService.createFile/createDir（创建三件套）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-create-'));
    svc = getFileService();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正向：createFile 创建空文件', async () => {
    const res = await svc.createFile({ path: join(dir, 'new.txt'), createDirs: false });
    expect(res.path).toContain('new.txt');
    const read = await svc.read({
      path: join(dir, 'new.txt'),
      offset: undefined,
      limit: undefined,
    });
    expect(read.content).toBe('');
  });

  it('正向：createFile 父目录自动创建（createDirs=true）', async () => {
    await svc.createFile({ path: join(dir, 'x', 'y.txt'), createDirs: true });
    expect(
      (await svc.read({ path: join(dir, 'x', 'y.txt'), offset: undefined, limit: undefined }))
        .content,
    ).toBe('');
  });

  it('异常：createFile 已存在 → ALREADY_EXISTS', async () => {
    await writeFile(join(dir, 'exists.txt'), 'x');
    await expect(
      svc.createFile({ path: join(dir, 'exists.txt'), createDirs: false }),
    ).rejects.toMatchObject({ code: ErrorCode.ALREADY_EXISTS });
  });

  it('正向：createDir 递归创建', async () => {
    const res = await svc.createDir({ path: join(dir, 'd1', 'd2') });
    expect(res.path).toContain('d1');
    const listed = await svc.list({ path: join(dir, 'd1'), depth: 1, includeHidden: false });
    expect(listed.entries.map((e) => e.name)).toContain('d2');
  });
});

describe('FileService.delete/rename（变更三件套）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-del-'));
    svc = getFileService();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正向：delete 删除文件', async () => {
    const f = join(dir, 'del.txt');
    await writeFile(f, 'x');
    const res = await svc.delete({ path: f, recursive: false });
    expect(res.deleted).toBe(true);
  });

  it('正向：delete recursive=true 删除目录树', async () => {
    const d = join(dir, 'tree');
    await mkdir(join(d, 'sub'), { recursive: true });
    await writeFile(join(d, 'sub', 'f.txt'), 'x');
    await svc.delete({ path: d, recursive: true });
    await expect(svc.list({ path: d, depth: 1, includeHidden: false })).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('异常：delete 不存在且 force=false → 抛错', async () => {
    await expect(svc.delete({ path: join(dir, 'ghost'), recursive: false })).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('异常：delete 相对路径 → INVALID_INPUT', async () => {
    await expect(svc.delete({ path: 'rel.txt', recursive: false })).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it('正向：rename 重命名成功', async () => {
    const from = join(dir, 'old.txt');
    const to = join(dir, 'new.txt');
    await writeFile(from, 'x');
    const res = await svc.rename({ oldPath: from, newPath: to, overwrite: false });
    expect(res.path).toContain('new.txt');
    expect((await svc.read({ path: to, offset: undefined, limit: undefined })).content).toBe('x');
  });

  it('异常：rename 目标已存在且 overwrite=false → ALREADY_EXISTS', async () => {
    const from = join(dir, 'a.txt');
    const to = join(dir, 'b.txt');
    await writeFile(from, 'a');
    await writeFile(to, 'b');
    await expect(
      svc.rename({ oldPath: from, newPath: to, overwrite: false }),
    ).rejects.toMatchObject({ code: ErrorCode.ALREADY_EXISTS });
  });

  it('正向：rename overwrite=true 覆盖目标', async () => {
    const from = join(dir, 'a.txt');
    const to = join(dir, 'b.txt');
    await writeFile(from, 'A');
    await writeFile(to, 'B');
    const res = await svc.rename({ oldPath: from, newPath: to, overwrite: true });
    expect(res.path).toContain('b.txt');
    expect((await svc.read({ path: to, offset: undefined, limit: undefined })).content).toBe('A');
  });

  it('异常：rename 源不存在 → 抛错', async () => {
    await expect(
      svc.rename({ oldPath: join(dir, 'ghost'), newPath: join(dir, 'x'), overwrite: false }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('FileService.read 补充边界（切片越界）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-read-'));
    svc = getFileService();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('边界：offset 超出行数 → content 空字符串（不视为错误）', async () => {
    const f = join(dir, 'lines.txt');
    await writeFile(f, 'line1\nline2', 'utf-8');
    const res = await svc.read({ path: f, offset: 99, limit: 10 });
    expect(res.content).toBe('');
    expect(res.totalLines).toBe(2);
  });

  it('异常：read 相对路径 → INVALID_INPUT', async () => {
    await expect(
      svc.read({ path: 'rel.txt', offset: undefined, limit: undefined }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
  });
});

describe('FileService.watch/unwatch/dispose（监听生命周期）', () => {
  let dir: string;
  let svc: IFileService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-watch-'));
    svc = getFileService();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** fake webContents：计数事件推送（基础设施 stub，非业务 mock） */
  function fakeWebContents(destroyed = false) {
    const events: unknown[] = [];
    return {
      wc: {
        isDestroyed: () => destroyed,
        send: (_ch: string, payload: unknown) => events.push(payload),
      },
      events,
    };
  }

  it('正向：监听目录 → 新建文件推送 create 事件 → unwatch 停止', async () => {
    const { wc, events } = fakeWebContents();
    const handle = await svc.watch({ path: dir, webContents: wc });
    expect(handle.watcherId).toBeTruthy();

    await writeFile(join(dir, 'new.txt'), 'x');
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(events[0]).toMatchObject({ type: 'create', path: expect.stringContaining('new.txt') });

    expect(svc.unwatch(handle.watcherId)).toBe(true);
  }, 10_000);

  it('正向：事件映射（addDir→create / change→modify / unlink→delete）', async () => {
    const { wc, events } = fakeWebContents();
    const handle = await svc.watch({ path: dir, webContents: wc });
    await writeFile(join(dir, 'f.txt'), 'a');
    await vi.waitFor(
      () => expect(events.some((e) => (e as { type: string }).type === 'create')).toBe(true),
      { timeout: 5000 },
    );
    await writeFile(join(dir, 'f.txt'), 'b');
    await vi.waitFor(
      () => expect(events.some((e) => (e as { type: string }).type === 'modify')).toBe(true),
      { timeout: 5000 },
    );
    await rm(join(dir, 'f.txt'));
    await vi.waitFor(
      () => expect(events.some((e) => (e as { type: string }).type === 'delete')).toBe(true),
      { timeout: 5000 },
    );
    svc.unwatch(handle.watcherId);
  }, 15_000);

  it('边界：webContents 已销毁 → 不推送（容错）', async () => {
    const { wc, events } = fakeWebContents(true);
    const handle = await svc.watch({ path: dir, webContents: wc });
    await writeFile(join(dir, 'ghost.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 800)); // 给 chokidar 处理时间
    expect(events).toHaveLength(0); // destroyed → handleWatchEvent 提前返回
    svc.unwatch(handle.watcherId);
  }, 10_000);

  it('异常：watch 相对路径 → INVALID_INPUT', async () => {
    const { wc } = fakeWebContents();
    await expect(svc.watch({ path: 'rel', webContents: wc })).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    });
  });

  it('边界：unwatch 不存在的 id → false', () => {
    expect(svc.unwatch('ghost-id')).toBe(false);
  });

  it('正向：dispose 关闭所有 watcher（幂等）', async () => {
    const { wc } = fakeWebContents();
    await svc.watch({ path: dir, webContents: wc });
    await svc.dispose();
    await svc.dispose(); // 第二次：watchers 已空
    expect(svc.unwatch('ghost')).toBe(false);
  }, 10_000);
});
