// src/main/infra/search/search-service.perf.test.ts
// 搜索性能基准：真实 ripgrep 子进程（对齐大仓库代码检索场景）
// ──────────────────────────────────────────────────────────────
// 职责：
// - grep：500 文件 × 50 行（约 25000 行）目录树中的匹配搜索耗时
// - 无匹配模式：全量扫描路径耗时（最坏情形）
// - glob：文件名模式匹配耗时
// - 结果正确性抽查：命中数与预期一致（防性能测试空转）
//
// 运行：pnpm test:perf:main
// 阈值策略：多轮采样中位数 + 宽松基线（Windows 子进程启动开销 ~10ms 级）
// ──────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSearchService } from './search-service';

let tempDir: string;
/** 全量文件路径（供 glob 基准用） */
const files: string[] = [];

/** 生成 500 文件 × 50 行（25000 行，中大型仓库单目录规模） */
function seedWorkspace(): void {
  for (let dir = 0; dir < 5; dir += 1) {
    const dirPath = join(tempDir, `module-${dir}`);
    mkdirSync(dirPath, { recursive: true });
    for (let f = 0; f < 100; f += 1) {
      const filePath = join(dirPath, `file-${f}.ts`);
      const lines: string[] = [];
      for (let l = 0; l < 50; l += 1) {
        // 每文件 1 行含目标关键字（保证命中可控），其余普通行
        lines.push(
          l === 25
            ? `const needle_${f} = 'bench-target-${f}';`
            : `line ${l}: const value_${l} = ${l};`,
        );
      }
      writeFileSync(filePath, lines.join('\n'), 'utf8');
      files.push(filePath);
    }
  }
}

/** 多次采样取中位数 */
async function sampleMedian(run: () => Promise<void>, rounds = 5): Promise<number> {
  const timings: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)] ?? 0;
}

describe('搜索性能基准（ripgrep）', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'code-agent-search-perf-'));
    seedWorkspace();
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 句柄延迟释放时跳过清理
    }
  });

  it('grep 命中搜索（25000 行）中位数 < 500ms 且结果正确', async () => {
    const service = getSearchService();
    // 预热：子进程启动开销不纳入采样
    await service.grep({
      pattern: 'bench-target-',
      paths: [tempDir],
      caseSensitive: false,
      isRegex: false,
      include: undefined,
      exclude: [],
      maxResults: 1000,
    });

    let matchCount = 0;
    const median = await sampleMedian(async () => {
      const res = await service.grep({
        pattern: 'bench-target-',
        paths: [tempDir],
        caseSensitive: false,
        isRegex: false,
        include: undefined,
        exclude: [],
        maxResults: 1000,
      });
      matchCount = res.matches.length;
    });
    console.log(
      `[perf] grep 命中（25000 行）中位数: ${median.toFixed(1)}ms，命中 ${matchCount} 条`,
    );
    // 500 文件各 1 条命中
    expect(matchCount, '命中数应为 500（防空转：结果正确性也是性能测试的一部分）').toBe(500);
    expect(median, 'grep 命中搜索应 < 500ms（基线，渐进收紧）').toBeLessThan(500);
  });

  it('grep 无匹配全扫描（最坏情形）中位数 < 500ms', async () => {
    const service = getSearchService();
    const median = await sampleMedian(async () => {
      await service.grep({
        pattern: 'zzz-no-match-zzz',
        paths: [tempDir],
        caseSensitive: false,
        isRegex: false,
        include: undefined,
        exclude: [],
        maxResults: 1000,
      });
    });
    console.log(`[perf] grep 无匹配全扫描中位数: ${median.toFixed(1)}ms`);
    expect(median, '无匹配全扫描应 < 500ms（基线，渐进收紧）').toBeLessThan(500);
  });

  it('glob 文件匹配（500 文件）中位数 < 500ms', async () => {
    const service = getSearchService();
    let fileCount = 0;
    const median = await sampleMedian(async () => {
      const res = await service.glob({
        pattern: '**/*.ts',
        path: tempDir,
        includeHidden: false,
        maxResults: 1000,
      });
      fileCount = res.files.length;
    });
    console.log(`[perf] glob（500 文件）中位数: ${median.toFixed(1)}ms，匹配 ${fileCount} 个`);
    expect(fileCount, 'glob 应命中全部 500 个 .ts 文件').toBe(500);
    expect(median, 'glob 匹配应 < 500ms（基线，渐进收紧）').toBeLessThan(500);
  });
});
