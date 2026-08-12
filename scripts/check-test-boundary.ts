// scripts/check-test-boundary.ts
// 测试边界门禁（工程化强制）· 设计文档 §3.6
// ──────────────────────────────────────────────────────────────
// 依据：单元/集成/E2E 边界 = 被测范围 × 替身位置 × 断言对象（§3.6 判定框架）
// 可程序化的结构信号：
//   1. 集成测试（tests/integration/**）禁止 vi.mock 同仓业务模块
//      （IO 边界模块允许替身：infra/storage、utils/logger、telemetry——业界简化环境方案）
//   2. 单测目录（src/**/*.test.ts）真实 IO 信号（真实 DB/WebSocket/HTTP server）
//      = "准集成测试"，必须登记 scripts/test-boundary-exempt.json
//   3. 恒真断言静态扫描（expect(true).toBe(true) 等字面量恒真 = 空跑）
// 级别：规则 1/2 为 error（卡关）；规则 3 为 warning（存量清零后升 error）
//
// 运行：pnpm check:test-boundary
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** IO 边界允许清单：集成测试允许替身的同仓模块（简化环境 Medium Test 的边界替身） */
const IO_BOUNDARY_MOCKS = [
  'infra/storage', // DB 层（替换为内存实现是标准做法）
  'llm-client/ai-provider', // LLM provider 工厂（外部服务边界，fake model 注入点）
  'utils/logger',
  'telemetry',
];

/** 真实 IO 信号（单测目录出现即"准集成"） */
const IO_SIGNALS: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /better-sqlite3/, name: 'better-sqlite3' },
  { re: /node:http|createServer\(/, name: 'http-server' },
  { re: /node:net|net\.createServer/, name: 'net-server' },
  { re: /new Database\(/, name: 'new Database' },
  { re: /WebSocket/, name: 'WebSocket' },
];

/** 恒真断言模式（完全字面量——不误报 expect(x).toBe(true) 这类变量断言） */
const TAUTOLOGY_PATTERNS = [
  /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
  /expect\(\s*false\s*\)\.toBe\(\s*false\s*\)/,
  /expect\(\s*1\s*\)\.toBe\(\s*1\s*\)/,
  /expect\(\s*0\s*\)\.toBe\(\s*0\s*\)/,
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

function collectFiles(dir: string, pattern: RegExp, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, pattern, acc);
    } else if (pattern.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 判断 vi.mock 参数是否指向同仓源码 */
function isSameRepoPath(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/');
}

/** 判断 mock 目标是否为允许的 IO 边界模块 */
function isIoBoundaryMock(specifier: string): boolean {
  return IO_BOUNDARY_MOCKS.some((p) => specifier.includes(p));
}

/** 提取 vi.mock 的参数 */
function extractViMockSpecifiers(content: string): string[] {
  const result: string[] = [];
  const re = /vi\.mock\(\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    result.push(m[1] as string);
  }
  return result;
}

function main(): void {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  // 登记表加载
  const exemptRaw = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'test-boundary-exempt.json'), 'utf-8'),
  ) as { entries: Array<{ file: string }> };
  const exemptFiles = new Set(exemptRaw.entries.map((e) => e.file.replaceAll('\\', '/')));

  // ── 规则 1：集成测试禁止 vi.mock 同仓业务模块 ───────────────
  const integrationDir = join(ROOT, 'tests', 'integration');
  for (const f of collectFiles(integrationDir, /\.test\.ts$/)) {
    const content = readFileSync(f, 'utf-8');
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const lines = content.split('\n');
    for (const [idx, line] of lines.entries()) {
      for (const spec of extractViMockSpecifiers(line)) {
        if (!isSameRepoPath(spec)) continue;
        // IO 边界替身（infra/storage 等）是简化环境 Medium Test 的标准做法，完全允许
        if (isIoBoundaryMock(spec)) continue;
        errors.push({
          file: rel,
          line: idx + 1,
          detail: `vi.mock('${spec}') 指向同仓业务模块 = 假集成（集成测试必须真实协作，只替身 IO 边界）`,
        });
      }
    }
  }

  // ── 规则 2：单测目录真实 IO = 准集成，必须登记 ───────────────
  const srcDir = join(ROOT, 'src');
  for (const f of collectFiles(srcDir, /\.test\.(ts|tsx)$/)) {
    const content = readFileSync(f, 'utf-8');
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const hits = IO_SIGNALS.filter((s) => s.re.test(content)).map((s) => s.name);
    if (hits.length > 0 && !exemptFiles.has(rel)) {
      errors.push({
        file: rel,
        line: 1,
        detail: `含真实 IO 信号（${hits.join('/')}）= 准集成测试，未登记——请加入 scripts/test-boundary-exempt.json`,
      });
    }
  }

  // ── 规则 3：恒真断言（warning，存量清零后升 error）──────────
  for (const f of collectFiles(join(ROOT, 'src'), /\.test\.(ts|tsx)$/)) {
    const content = readFileSync(f, 'utf-8');
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const lines = content.split('\n');
    for (const [idx, line] of lines.entries()) {
      if (TAUTOLOGY_PATTERNS.some((p) => p.test(line))) {
        warnings.push({
          file: rel,
          line: idx + 1,
          detail: '恒真断言（字面量自比）= 空跑，应断言真实副作用',
        });
      }
    }
  }

  // ── 输出 ───────────────────────────────────────────────────
  if (errors.length > 0) {
    console.error(`❌ 测试边界违规 ${errors.length} 处（error）：`);
    for (const e of errors) {
      console.error(`  ${e.file}:${e.line} — ${e.detail}`);
    }
  }
  if (warnings.length > 0) {
    console.warn(`⚠️  测试边界提示 ${warnings.length} 处（warning）：`);
    for (const w of warnings) {
      console.warn(`  ${w.file}:${w.line} — ${w.detail}`);
    }
  }
  if (errors.length === 0) {
    console.log(`✅ 测试边界检查通过（${warnings.length} 条 warning）`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
