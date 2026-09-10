// tests/integration/file.test.ts
// File 域集成测试（batch 3/9 · 核心链路）
// ──────────────────────────────────────────────────────────────
// 链路：IPC handler（真实）→ FileService（真实）→ 真实文件系统（临时目录）
// 替身：仅 webContents（watch 事件推送目标）
//
// 维度覆盖：接口契约 / 错误传播（classify*Error → 错误码）/ 资源生命周期（watch 清理）
// 场景：安全边界（工作区收口：越界/遍历拒绝、无边界 fail closed）/ 幂等（重复 delete）/
//       并发（并行 write）/ 事件流完整性（watch 事件序列）/
//       持久化往返（write→read 文件系统真实落盘）
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getFileService } from '../../src/main/infra/file/file-service';
import { createFileHandlers } from '../../src/main/ipc/file.handler';
import { createFakeWebContents } from './helpers/fake-webcontents';

// Windows CI：chokidar 原生 fs-event 在「watch 目录随即被删除」的时序触发 libuv
// 断言崩溃（fail-fast 0xC0000409，src\win\fs-event.c）——与 file-service.test.ts
// 一致，统一走轮询模式绕开原生监视器。
process.env['FILE_WATCH_USE_POLLING'] = '1';

// 单例隔离：每用例后 dispose 清理 watcher（FileService 单例无 reset 导出）
afterEach(async () => {
  await getFileService().dispose();
});

/** 每用例独立临时目录（真实文件系统边界） */
function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-file-'));
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, maxRetries: 5 });
    }
  })();
}

/**
 * 构造文件域 handler：把本用例临时目录注入工作区边界
 *
 * handler 层会先把渲染层路径收口到「工作区根集合」（生产环境来自会话 workingDir），
 * 测试没有会话表 → 必须显式注入边界，否则一律 fail closed 被拒。
 */
function makeHandlers(dir: string): ReturnType<typeof createFileHandlers> {
  return createFileHandlers({
    fileService: getFileService(),
    workspaceRoots: async () => [dir],
  });
}

describe('file 域集成链路（batch 3）', () => {
  it('正向：write→read 往返（真实文件系统落盘）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'hello.txt');

      const written = await handlers.write({ path: filePath, content: '第一行\n第二行' });
      expect(written.bytesWritten).toBe(Buffer.byteLength('第一行\n第二行', 'utf-8'));

      const read = await handlers.read({ path: filePath });
      expect(read.content).toBe('第一行\n第二行');
      expect(read.totalLines).toBe(2);
    });
  });

  it('正向：append 追加累积内容', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'log.txt');

      await handlers.write({ path: filePath, content: 'line1\n' });
      await handlers.write({ path: filePath, content: 'line2\n', append: true });
      const read = await handlers.read({ path: filePath });
      expect(read.content).toBe('line1\nline2\n');
    });
  });

  it('正向：create/createDir + list 目录结构', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      await handlers.createDir({ path: join(dir, 'src', 'components') });
      await handlers.create({ path: join(dir, 'src', 'index.ts') });
      await handlers.create({ path: join(dir, 'README.md') });

      const list = await handlers.list({ path: dir, depth: 3 });
      const names = list.entries.map((e) => e.name);
      expect(names).toContain('src');
      expect(names).toContain('README.md');
      const src = list.entries.find((e) => e.name === 'src');
      expect(src?.type).toBe('directory');
    });
  });

  it('正向：delete 文件与递归目录', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'a.txt');
      const dirPath = join(dir, 'nested', 'deep');
      await handlers.write({ path: filePath, content: 'x' });
      await handlers.createDir({ path: dirPath });
      await handlers.create({ path: join(dirPath, 'inner.txt') });

      // P0 契约：recursive 必填（文件 false / 目录树 true）
      await handlers.delete({ path: filePath, recursive: false });
      await handlers.delete({ path: join(dir, 'nested'), recursive: true });

      const list = await handlers.list({ path: dir, depth: 5 });
      expect(list.entries).toHaveLength(0);
    });
  });

  it('正向：rename 文件与目录（移动语义）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const from = join(dir, 'old.txt');
      const to = join(dir, 'new.txt');
      await handlers.write({ path: from, content: '内容' });

      await handlers.rename({ oldPath: from, newPath: to });
      const read = await handlers.read({ path: to });
      expect(read.content).toBe('内容');
      await expect(handlers.read({ path: from })).rejects.toMatchObject({});
    });
  });

  it('正向：watch 变更事件序列（watchStart→write→事件→watchStop）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const { wc, sent } = createFakeWebContents();

      const { watcherId } = await handlers.watchStart({ path: dir }, {
        traceId: 't',
        sender: wc,
      } as never);
      expect(watcherId).toBeDefined();

      // 触发文件变更
      const filePath = join(dir, 'watch-me.txt');
      await handlers.write({ path: filePath, content: 'v1' });

      // 等待 watch 事件推送（chokidar 异步；真实等待 ≥5× 事件循环延迟）
      await vi.waitFor(
        () => {
          expect(sent.some((s) => s.channel.includes('watch:event'))).toBe(true);
        },
        { timeout: 2000 },
      );
      const event = sent.find((s) => s.channel.includes('watch:event'))?.payload as {
        watcherId: string;
        event: string;
      };
      expect(event.watcherId).toBe(watcherId);

      // 资源生命周期：watchStop 后不再推送
      const { stopped } = await handlers.watchStop({ watcherId });
      expect(stopped).toBe(true);
      expect((await handlers.watchStop({ watcherId })).stopped).toBe(false);
    });
  });

  it('边界：read 分片（offset/limit）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'big.txt');
      const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
      await handlers.write({ path: filePath, content: lines.join('\n') });

      const page1 = await handlers.read({ path: filePath, offset: 0, limit: 3 });
      expect(page1.content).toBe('line-0\nline-1\nline-2');
      expect(page1.totalLines).toBe(10);
      const page4 = await handlers.read({ path: filePath, offset: 9, limit: 3 });
      expect(page4.content).toBe('line-9');
    });
  });

  it('边界：空文件与 offset 超界', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'empty.txt');
      await handlers.create({ path: filePath });

      const read = await handlers.read({ path: filePath });
      // 空文件 split 后为 1 行（空串语义）
      expect(read.content).toBe('');
      expect(read.totalLines).toBe(1);
      // offset 超界返回空（不视为错误）
      const beyond = await handlers.read({ path: filePath, offset: 100 });
      expect(beyond.content).toBe('');
    });
  });

  it('边界：createDirs 自动创建父目录', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const deepPath = join(dir, 'a', 'b', 'c', 'deep.txt');
      await handlers.write({ path: deepPath, content: 'x', createDirs: true });
      const read = await handlers.read({ path: deepPath });
      expect(read.content).toBe('x');
    });
  });

  it('异常：read 不存在 → 错误码', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      await expect(handlers.read({ path: join(dir, 'missing.txt') })).rejects.toMatchObject({});
    });
  });

  it('安全边界：工作区收口拒绝越权路径（越界 / 遍历 / 无边界 fail closed）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      // 相对路径按工作区根解析：落在根内，但无法借此读越权路径
      await handlers.write({ path: 'inside.txt', content: 'x' });
      expect((await handlers.read({ path: join(dir, 'inside.txt') })).content).toBe('x');
      // .. 遍历逃出根 → 越权
      await expect(handlers.read({ path: join('..', 'Windows', 'win.ini') })).rejects.toMatchObject(
        { code: 'UNAUTHORIZED' },
      );
      // 工作区外绝对路径 → 越权
      await expect(
        handlers.read({ path: join(tmpdir(), 'outside-secret.txt') }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  it('安全边界：无工作区根时 fail closed（拒绝一切路径）', async () => {
    await withTempDir(async (dir) => {
      const handlers = createFileHandlers({
        fileService: getFileService(),
        workspaceRoots: async () => [],
      });
      await expect(handlers.read({ path: join(dir, 'x.txt') })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  it('异常：create 已存在 → 报错', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      const filePath = join(dir, 'exists.txt');
      await handlers.create({ path: filePath });
      await expect(handlers.create({ path: filePath })).rejects.toBeDefined();
    });
  });

  it('异常：delete 不存在 → 报错（严格模式 force:false）', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      await expect(
        handlers.delete({ path: join(dir, 'never-existed'), recursive: false }),
      ).rejects.toBeDefined();
      // 已删除文件的再次删除同样报错（严格语义）
      const filePath = join(dir, 'gone.txt');
      await handlers.create({ path: filePath });
      await handlers.delete({ path: filePath, recursive: false });
      await expect(handlers.delete({ path: filePath, recursive: false })).rejects.toBeDefined();
    });
  });

  it('并发：并行 write 互不干扰', async () => {
    await withTempDir(async (dir) => {
      const handlers = makeHandlers(dir);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          handlers.write({ path: join(dir, `f-${i}.txt`), content: `内容${i}` }),
        ),
      );
      const list = await handlers.list({ path: dir, depth: 1 });
      expect(list.entries).toHaveLength(10);
    });
  });
});
