// src/main/infra/memory-hub/memory-hub.contract.test.ts
// MemoryHub 契约测试：真实拉起上游 gateway 子进程走全链路（无 mock）
// ──────────────────────────────────────────────────────────────
// 运行条件：环境变量 MEMORY_HUB_ROOT 指向上游源码根目录（含 node_modules）。
// 未设置时整组跳过——CI 与未配置开发者环境不依赖上游源码。
// 验证点：
// - sidecar 启动 + /health 就绪
// - capture 写入 L0（真实 HTTP 往返）
// - recall 在 keyword 策略下返回结构化成功（不再报 hybrid 缺 embedding 的 10001）
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryHubService } from './memory-hub-service';
import { createNodeLauncher } from './node-launcher';

const HUB_ROOT = process.env['MEMORY_HUB_ROOT'];
const describeIf = HUB_ROOT !== undefined && HUB_ROOT.length > 0 ? describe : describe.skip;

// 启动器说明（2026-09-13）：生产经 Electron utilityProcess 启动子进程，而 vitest
// 运行在纯 Node 环境（无 Electron 运行时，utilityProcess 为 undefined）。为保持
// "真实拉起引擎走全链路"的验证强度，测试注入 Node 等价启动器（契约一致）。
// 生产路径固定走 utilityProcess（engine-process.ts），由 Electron E2E/smoke 覆盖。
describeIf('MemoryHubService 契约（需 MEMORY_HUB_ROOT）', () => {
  let dataDir = '';
  let service: MemoryHubService;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-hub-contract-'));
    service = new MemoryHubService({
      hubRoot: HUB_ROOT,
      dataDir,
      launcher: await createNodeLauncher(),
      // 函数形态（生产路径）：覆盖 resolver 分支——异步解析静态值注入 yaml
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
    // 首次用例承担 sidecar 冷启动。注：生产走 tsx 直跑 TS 源码，冷启动需即时编译
    // （本机实测 v2.0.2 约 13–15s，v2.0.1 约 5–11s）；上游 20s 就绪超时内。
    // 该成本是 tsx 运行时的固有开销，根治手段是预处理为 JS（见 README 的后续优化）。
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
    // 上游 RecallRequest 要求 session_key 非空（缺失/空串 → HTTP 400）。
    // 必须 ok=true——失败即说明请求契约不满足（无真实蒸馏 LLM 时 L1 为空属预期）。
    expect(result.ok).toBe(true);
  }, 20_000);

  it('recall 缺 session_key 被上游拒绝（回归守卫：防调用方再次漏传）', async () => {
    const port = await service.ensureStarted();
    const result = await port.recall({ query: '项目约定是什么' });
    // 不带 session_key 必然 400——锁住上游契约，防止调用方再次漏传（曾有实际 bug）
    expect(result.ok).toBe(false);
    expect(result.message).toContain('400');
  }, 20_000);

  it('写入→检索回环：capture 的对话可被 searchConversations 检索到（引擎级记忆闭环）', async () => {
    const port = await service.ensureStarted();
    // 唯一标记避免与历史测试数据碰撞
    const marker = `qwikzorb-${Date.now().toString(36)}`;
    const captured = await port.capture({
      sessionKey: 'contract-roundtrip',
      userContent: `部署约定标记 ${marker}：发布前必须跑 typecheck`,
      assistantContent: '已记录部署约定。',
    });
    expect(captured.l0Recorded).toBeGreaterThanOrEqual(1);
    // FTS 索引为异步落盘，短轮询等待可见（上限 10s；慢机上 5s 偶发不足）
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
    // 同一条记忆同时含中英文特征词，验证两种语言的查询都能命中
    await port.capture({
      sessionKey: 'contract-bilingual',
      userContent: `项目约定 ${marker}：包管理器使用 pnpm`,
      assistantContent: 'Noted: package manager is pnpm.',
    });

    /** 短轮询等待 FTS 索引可见 */
    const searchHit = async (query: string): Promise<boolean> => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const res = await port.searchConversations(query, 5);
        if (res.content.includes(marker) && res.total > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    };

    // 中文分词（jieba）与英文词元（FTS5）都能命中同一条记录。
    // 说明：我们使用默认 sqlite 后端（getCapabilities().sparseVectors === false，
    // 不走 BM25 稀疏向量），故配置项 bm25.language 对本集成不生效——中英文
    // 由 jieba + FTS5 统一处理，无需语言切换（曾经的"两份词典+切换"方案基于
    // tcvdb 后端，与我们的实际配置不符）。
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
