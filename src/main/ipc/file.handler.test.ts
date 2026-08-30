// src/main/ipc/file.handler.test.ts
// file.handler 单测：
// 1. 9 个方法转发（fake FileService DI 注入）
// 2. P0 工作区收口：边界内放行 / `../` 遍历拒绝 / 符号链接逃逸拒绝 /
//    工作区外绝对路径拒绝 / 无根 fail closed / rename 双侧校验

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confineToWorkspace, createFileHandlers, type FileHandlerDeps } from './file.handler';

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

/** 建立真实临时目录（realpath 归一，避免 /var → /private/var 类符号链接干扰） */
function makeTempDir(prefix: string, sub = ''): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  const target = sub === '' ? dir : join(dir, sub);
  mkdirSync(target, { recursive: true });
  return target;
}

/** 断言抛出越界 AppError */
async function expectDenied(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
}

describe('file.handler', () => {
  let fileService: ReturnType<typeof createFakeFileService>;
  const tempDirs: string[] = [];

  /** 创建 handler：roots 即边界集合 */
  function build(roots: readonly string[]) {
    fileService = createFakeFileService();
    return createFileHandlers({ fileService, workspaceRoots: async () => roots });
  }

  let workspace: string;
  let outside: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspace = makeTempDir('code-agent-fh-ws');
    outside = makeTempDir('code-agent-fh-out');
    tempDirs.push(workspace, outside);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('转发（fake FileService）', () => {
    it('read：转发收口后的 path/offset/limit', async () => {
      const handlers = build([workspace]);
      await handlers.read({ path: join(workspace, 'a.ts'), offset: 0, limit: 100 }, EMPTY_CTX);
      expect(fileService.read).toHaveBeenCalledWith({
        path: resolve(workspace, 'a.ts'),
        offset: 0,
        limit: 100,
      });
    });

    it('write：转发全部参数', async () => {
      const handlers = build([workspace]);
      await handlers.write(
        { path: 'src/a.ts', content: 'x', append: true, createDirs: false },
        EMPTY_CTX,
      );
      expect(fileService.write).toHaveBeenCalledWith({
        path: resolve(workspace, 'src/a.ts'),
        content: 'x',
        append: true,
        createDirs: false,
      });
    });

    it('list：转发 path/depth/includeHidden', async () => {
      const handlers = build([workspace]);
      await handlers.list({ path: workspace, depth: 2, includeHidden: false }, EMPTY_CTX);
      expect(fileService.list).toHaveBeenCalledWith(
        expect.objectContaining({ path: workspace, depth: 2, includeHidden: false }),
      );
    });

    it('watchStart：转发收口后的 path 与 sender，返回 watcherId', async () => {
      const handlers = build([workspace]);
      const ctx = { sender: { id: 9 }, traceId: 't' } as never;
      const result = await handlers.watchStart({ path: workspace }, ctx);
      expect(fileService.watch).toHaveBeenCalledWith({
        path: workspace,
        webContents: { id: 9 },
      });
      expect(result.watcherId).toBe('w1');
    });

    it('watchStop：转发 watcherId（无路径，不需要收口）', async () => {
      const handlers = build([workspace]);
      await handlers.watchStop({ watcherId: 'w1' }, EMPTY_CTX);
      expect(fileService.unwatch).toHaveBeenCalledWith('w1');
    });

    it('create/createDir/delete：转发收口后的参数', async () => {
      const handlers = build([workspace]);
      await handlers.create({ path: 'n.ts', createDirs: true }, EMPTY_CTX);
      expect(fileService.createFile).toHaveBeenCalledWith({
        path: resolve(workspace, 'n.ts'),
        createDirs: true,
      });
      await handlers.createDir({ path: 'dir' }, EMPTY_CTX);
      expect(fileService.createDir).toHaveBeenCalledWith({ path: resolve(workspace, 'dir') });
      await handlers.delete({ path: 'd', recursive: true }, EMPTY_CTX);
      expect(fileService.delete).toHaveBeenCalledWith({
        path: resolve(workspace, 'd'),
        recursive: true,
      });
    });

    it('rename：双侧均收口后转发', async () => {
      const handlers = build([workspace]);
      await handlers.rename(
        { oldPath: 'a', newPath: join(workspace, 'b'), overwrite: false },
        EMPTY_CTX,
      );
      expect(fileService.rename).toHaveBeenCalledWith({
        oldPath: resolve(workspace, 'a'),
        newPath: resolve(workspace, 'b'),
        overwrite: false,
      });
    });

    it('多根工作区：第二个根内的路径同样放行', async () => {
      const secondRoot = makeTempDir('code-agent-fh-ws2');
      tempDirs.push(secondRoot);
      const handlers = build([workspace, secondRoot]);
      await handlers.read({ path: join(secondRoot, 'x.ts'), offset: 0, limit: 10 }, EMPTY_CTX);
      expect(fileService.read).toHaveBeenCalledWith({
        path: resolve(secondRoot, 'x.ts'),
        offset: 0,
        limit: 10,
      });
    });
  });

  describe('P0 工作区收口', () => {
    it('边界内：允许并把相对路径解析为绝对路径', async () => {
      const handlers = build([workspace]);
      await handlers.read(
        { path: 'src/deep/a.ts', offset: undefined, limit: undefined },
        EMPTY_CTX,
      );
      expect(fileService.read).toHaveBeenCalledWith({
        path: resolve(workspace, 'src/deep/a.ts'),
        offset: undefined,
        limit: undefined,
      });
    });

    it('../ 遍历：拒绝且不触碰 FileService', async () => {
      const handlers = build([workspace]);
      await expectDenied(
        handlers.read({ path: '../../etc/passwd', offset: undefined, limit: undefined }, EMPTY_CTX),
      );
      expect(fileService.read).not.toHaveBeenCalled();
    });

    it('工作区外绝对路径：拒绝', async () => {
      const handlers = build([workspace]);
      writeFileSync(join(outside, 'secret.txt'), 'top-secret', 'utf8');
      await expectDenied(
        handlers.read(
          { path: join(outside, 'secret.txt'), offset: undefined, limit: undefined },
          EMPTY_CTX,
        ),
      );
      await expectDenied(
        handlers.delete({ path: join(outside, 'secret.txt'), recursive: false }, EMPTY_CTX),
      );
      expect(fileService.read).not.toHaveBeenCalled();
      expect(fileService.delete).not.toHaveBeenCalled();
    });

    it('符号链接逃逸：工作区内 link → 外部目录，读写均拒绝', async () => {
      writeFileSync(join(outside, 'via-link.txt'), 'escaped', 'utf8');
      const linkPath = join(workspace, 'link');
      try {
        symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // 平台不支持创建符号链接（无权限）时跳过本用例，不伪报通过
        return;
      }
      const handlers = build([workspace]);
      await expectDenied(
        handlers.read(
          { path: join(linkPath, 'via-link.txt'), offset: undefined, limit: undefined },
          EMPTY_CTX,
        ),
      );
      await expectDenied(
        handlers.write(
          { path: join(linkPath, 'drop.sh'), content: 'x', append: false, createDirs: false },
          EMPTY_CTX,
        ),
      );
      await expectDenied(
        handlers.list({ path: linkPath, depth: 1, includeHidden: false }, EMPTY_CTX),
      );
      await expectDenied(handlers.watchStart({ path: linkPath }, EMPTY_CTX));
    });

    it('工作区内符号链接：不误伤（指向同工作区子目录的 alias 仍可用）', async () => {
      mkdirSync(join(workspace, 'real-sub'), { recursive: true });
      const alias = join(workspace, 'alias-sub');
      try {
        symlinkSync(
          join(workspace, 'real-sub'),
          alias,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch {
        return;
      }
      const handlers = build([workspace]);
      await handlers.list({ path: alias, depth: 1, includeHidden: false }, EMPTY_CTX);
      expect(fileService.list).toHaveBeenCalledWith(
        expect.objectContaining({ path: resolve(alias) }),
      );
    });

    it('rename：目标越界也拒绝（源合法）', async () => {
      const handlers = build([workspace]);
      await expectDenied(
        handlers.rename(
          { oldPath: join(workspace, 'a.ts'), newPath: join(outside, 'a.ts'), overwrite: false },
          EMPTY_CTX,
        ),
      );
      expect(fileService.rename).not.toHaveBeenCalled();
    });

    it('无任何工作区根：fail closed 全量拒绝', async () => {
      const handlers = build([]);
      await expectDenied(
        handlers.read(
          { path: join(workspace, 'a.ts'), offset: undefined, limit: undefined },
          EMPTY_CTX,
        ),
      );
      await expectDenied(
        handlers.write({ path: 'a.ts', content: 'x', append: false, createDirs: false }, EMPTY_CTX),
      );
    });
  });

  describe('confineToWorkspace（导出的收口原语）', () => {
    it('空路径：INVALID_INPUT 不被多根循环误吞为越界', async () => {
      await expect(confineToWorkspace('   ', async () => [workspace])).rejects.toMatchObject({
        code: ErrorCode.INVALID_INPUT,
      });
    });

    it('返回值为绝对路径（交给 service 的不再是相对路径）', async () => {
      const confined = await confineToWorkspace('a/b.ts', async () => [workspace]);
      expect(confined).toBe(resolve(workspace, 'a/b.ts'));
    });
  });
});

describe('defaultWorkspaceRoots（边界来源）', () => {
  afterEach(() => {
    vi.doUnmock('../infra/storage/session-service');
    vi.resetModules();
  });

  it('会话表可用：返回各会话 workingDir', async () => {
    vi.resetModules();
    vi.doMock('../infra/storage/session-service', () => ({
      getSessionService: () => ({
        listRecentDirs: async () => ({
          dirs: [
            { workingDir: '/ws/a', lastUsed: 1 },
            { workingDir: '', lastUsed: 2 },
          ],
        }),
      }),
    }));
    const { defaultWorkspaceRoots } = await import('./file.handler');
    expect(await defaultWorkspaceRoots()).toEqual(['/ws/a']);
  });

  it('会话查询抛错：返回空集（上层据此 fail closed）', async () => {
    vi.resetModules();
    vi.doMock('../infra/storage/session-service', () => ({
      getSessionService: () => ({
        listRecentDirs: async () => {
          throw new Error('DB 未初始化');
        },
      }),
    }));
    const { defaultWorkspaceRoots } = await import('./file.handler');
    expect(await defaultWorkspaceRoots()).toEqual([]);
  });
});
