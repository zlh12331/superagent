// src/main/ipc/file.handler.test.ts
// file.handler 单测：9 个方法转发（fake FileService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileHandlers, type FileHandlerDeps } from './file.handler';

/** 创建 fake FileService */
function createFakeFileService() {
  return {
    read: vi.fn(async () => ({ content: '', size: 0 })),
    write: vi.fn(async () => ({ ok: true })),
    list: vi.fn(async () => ({ entries: [] })),
    watch: vi.fn(async () => ({ watcherId: 'w1' })),
    unwatch: vi.fn(() => true),
    createFile: vi.fn(async () => ({ ok: true })),
    createDir: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ ok: true })),
  } as unknown as FileHandlerDeps['fileService'];
}

const EMPTY_CTX = {} as never;

describe('file.handler', () => {
  let fileService: ReturnType<typeof createFakeFileService>;
  let handlers: ReturnType<typeof createFileHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    fileService = createFakeFileService();
    handlers = createFileHandlers({ fileService });
  });

  it('read：转发 path/offset/limit', async () => {
    await handlers.read({ path: '/a.ts', offset: 0, limit: 100 }, EMPTY_CTX);
    expect(fileService.read).toHaveBeenCalledWith({ path: '/a.ts', offset: 0, limit: 100 });
  });

  it('write：转发全部参数', async () => {
    await handlers.write(
      { path: '/a.ts', content: 'x', append: true, createDirs: false },
      EMPTY_CTX,
    );
    expect(fileService.write).toHaveBeenCalledWith({
      path: '/a.ts',
      content: 'x',
      append: true,
      createDirs: false,
    });
  });

  it('list：转发 path/depth/includeHidden', async () => {
    await handlers.list({ path: '/', depth: 2, includeHidden: false }, EMPTY_CTX);
    expect(fileService.list).toHaveBeenCalledWith({ path: '/', depth: 2, includeHidden: false });
  });

  it('watchStart：转发 path 与 sender，返回 watcherId', async () => {
    const ctx = { sender: { id: 9 }, traceId: 't' } as never;
    const result = await handlers.watchStart({ path: '/watch' }, ctx);
    expect(fileService.watch).toHaveBeenCalledWith({ path: '/watch', webContents: { id: 9 } });
    expect(result.watcherId).toBe('w1');
  });

  it('watchStop：转发 watcherId', async () => {
    await handlers.watchStop({ watcherId: 'w1' }, EMPTY_CTX);
    expect(fileService.unwatch).toHaveBeenCalledWith('w1');
  });

  it('create/createDir/delete/rename：转发参数', async () => {
    await handlers.create({ path: '/n.ts', createDirs: true }, EMPTY_CTX);
    expect(fileService.createFile).toHaveBeenCalledWith({ path: '/n.ts', createDirs: true });
    await handlers.createDir({ path: '/dir' }, EMPTY_CTX);
    expect(fileService.createDir).toHaveBeenCalledWith({ path: '/dir' });
    await handlers.delete({ path: '/d', recursive: true }, EMPTY_CTX);
    expect(fileService.delete).toHaveBeenCalledWith({ path: '/d', recursive: true });
    await handlers.rename({ oldPath: '/a', newPath: '/b', overwrite: false }, EMPTY_CTX);
    expect(fileService.rename).toHaveBeenCalledWith({
      oldPath: '/a',
      newPath: '/b',
      overwrite: false,
    });
  });
});
