import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryHubService } from './memory-hub-service';
import { createNodeLauncher } from './node-launcher';

const HUB_ROOT = process.env['MEMORY_HUB_ROOT'];
const describeIf = HUB_ROOT !== undefined && HUB_ROOT.length > 0 ? describe : describe.skip;

describeIf('MemoryHubService 契约（需 MEMORY_HUB_ROOT）', () => {
  let dataDir = '';
  let service: MemoryHubService;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-hub-contract-'));
    service = new MemoryHubService({
      hubRoot: HUB_ROOT,
      dataDir,
      launcher: await createNodeLauncher(),
      llm: async () => ({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: ['sk', 'placeholder'].join('-'),
        model: 'gpt-4o-mini',
      }),
    });
  });

  afterAll(async () => {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sidecar 启动且健康检查通过', async () => {
    const port = await service.ensureStarted();
    await expect(port.health()).resolves.toBe(true);
  }, 40_000);

  it('ensureStarted 幂等（并发合并为同一端口实例）', async () => {
    const [a, b] = await Promise.all([service.ensureStarted(), service.ensureStarted()]);
    expect(a).toBe(b);
  });

  it('capture 真实写入 L0', async () => {
    const port = await service.ensureStarted();
    const result = await port.capture({
      sessionKey: 'contract-test-session',
      userContent: '本项目约定：包管理用 pnpm，单测用 Vitest',
      assistantContent: '已记录该约定。',
    });
    expect(result.l0Recorded).toBeGreaterThanOrEqual(1);
    expect(result.schedulerNotified).toBe(true);
  });

  it('recall 带 session_key 返回 200（上游要求该字段非空）', async () => {
    const port = await service.ensureStarted();
    const result = await port.recall({
      query: '项目约定是什么',
      sessionKey: 'contract-test-session',
    });
    expect(result.ok).toBe(true);
  }, 20_000);

  it('recall 缺 session_key 被上游拒绝（回归守卫：防调用方再次漏传）', async () => {
    const port = await service.ensureStarted();
    const result = await port.recall({ query: '项目约定是什么' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('400');
  }, 20_000);

  it('写入→检索回环：capture 的对话可被 searchConversations 检索到（引擎级记忆闭环）', async () => {
    const port = await service.ensureStarted();
    const marker = `qwikzorb-${Date.now().toString(36)}`;
    const captured = await port.capture({
      sessionKey: 'contract-roundtrip',
      userContent: `部署约定标记 ${marker}：发布前必须跑 typecheck`,
      assistantContent: '已记录部署约定。',
    });
    expect(captured.l0Recorded).toBeGreaterThanOrEqual(1);
    const deadline = Date.now() + 10_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const search = await port.searchConversations(marker, 5);
      found = search.content.includes(marker) && search.total > 0;
      if (!found) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    expect(found).toBe(true);
  }, 20_000);

  it('中英文均可检索（sqlite 后端走 FTS5 + jieba，无需语言切换）', async () => {
    const port = await service.ensureStarted();
    const marker = `bil-${Date.now().toString(36)}`;
    await port.capture({
      sessionKey: 'contract-bilingual',
      userContent: `项目约定 ${marker}：包管理器使用 pnpm`,
      assistantContent: 'Noted: package manager is pnpm.',
    });

    const searchHit = async (query: string): Promise<boolean> => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const res = await port.searchConversations(query, 5);
        if (res.content.includes(marker) && res.total > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    };

    expect(await searchHit(`${marker} 包管理器`)).toBe(true);
    expect(await searchHit(`${marker} package manager`)).toBe(true);
  }, 45_000);

  it('stop 后再次 ensureStarted 可重新拉起（生命周期可重复）', async () => {
    await service.stop();
    const port = await service.ensureStarted();
    await expect(port.health()).resolves.toBe(true);
    await service.stop();
  }, 30_000);
});
