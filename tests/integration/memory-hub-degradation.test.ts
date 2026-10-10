import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryHubService } from '../../src/main/infra/memory-hub/memory-hub-service';
import type { MemoryCaptureInput } from '../../src/main/infra/memory-hub/types';

describe('memory-hub 降级链（发布包占位符场景）', () => {
  let dataDir: string;
  let hubRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mh-data-'));
    hubRoot = mkdtempSync(join(tmpdir(), 'mh-root-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(hubRoot, { recursive: true, force: true });
  });

  it('hubRoot 未配置：ensureStarted 返回空实现（isConfigured=false）', async () => {
    const svc = new MemoryHubService({ hubRoot: undefined, dataDir });
    expect(svc.isConfigured()).toBe(false);

    const port = await svc.ensureStarted();
    expect(await port.health()).toBe(false);
  });

  it('hubRoot 指向占位目录：降级为空实现而非抛错（发布包实际行为）', async () => {
    const svc = new MemoryHubService({ hubRoot, dataDir });
    expect(svc.isConfigured()).toBe(true);

    const port = await svc.ensureStarted();
    expect(await port.health()).toBe(false);
  });

  it('降级端口全接口契约：capture 零落盘 / recall ok=false / 检索空', async () => {
    const svc = new MemoryHubService({ hubRoot, dataDir });
    const port = await svc.ensureStarted();

    const input: MemoryCaptureInput = {
      sessionKey: 'sess-1',
      userContent: '用户消息',
      assistantContent: '助手消息',
    };
    await expect(port.capture(input)).resolves.toEqual({
      l0Recorded: 0,
      schedulerNotified: false,
    });
    await expect(port.recall({ query: 'anything' })).resolves.toEqual({
      ok: false,
      context: '',
      memoryCount: 0,
      message: 'memory-hub not configured',
    });
    await expect(port.searchMemories('q')).resolves.toEqual({ content: '', total: 0 });
    await expect(port.searchConversations('q')).resolves.toEqual({ content: '', total: 0 });
    await expect(port.clear()).resolves.toMatchObject({ ok: false, deletedCount: 0 });
  });

  it('ensureStarted 幂等：重复调用返回同一端口实例（双启动保护）', async () => {
    const svc = new MemoryHubService({ hubRoot, dataDir });
    const first = await svc.ensureStarted();
    const second = await svc.ensureStarted();
    expect(second).toBe(first);
  });

  it('listL0BySession：数据目录缺失时返回空列表（只读展示路径，不依赖引擎）', async () => {
    const svc = new MemoryHubService({ hubRoot, dataDir });
    await expect(svc.listL0BySession('sess-1')).resolves.toEqual([]);
  });
});
