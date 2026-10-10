// scripts/check-test-boundary.ts
// 测试边界门禁（设计文档 §3.6：边界 = 被测范围 × 替身位置 × 断言对象），三条规则均 error：
//   ① 集成测试禁 vi.mock 同仓业务模块（IO 边界模块可替身：storage/logger/telemetry 等）
//   ② 单测目录出现真实 IO 信号（真实 DB/HTTP server/WebSocket）= 准集成，须登记豁免表
//   ③ 恒真断言（字面量自比 = 空跑）——2026-09-17 由 warning 升 error（存量已清零防回归）
// 运行：pnpm check:test-boundary

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** IO 边界允许清单：集成测试允许替身的同仓模块（简化环境 Medium Test 的边界替身） */
const IO_BOUNDARY_MOCKS = [
  'infra/storage',
  'llm-client/ai-provider',
  'mcp/mcp-client',
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

function main(): void {
  const errors: Finding[] = [];

  const exemptRaw = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'test-boundary-exempt.json'), 'utf-8'),
  ) as { entries: Array<{ file: string }> };
  const exemptFiles = new Set(exemptRaw.entries.map((e) => e.file.replaceAll('\\', '/')));

  const integrationDir = join(ROOT, 'tests', 'integration');
  for (const f of collectFiles(integrationDir, /\.test\.ts$/)) {
    const content = readFileSync(f, 'utf-8');
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const contentNoComments = content
      .split('\n')
      .map((l) => (l.trim().startsWith('//') || l.trim().startsWith('*') ? '' : l))
      .join('\n');
    const re = /vi\.mock\(\s*['"]([^'"]+)['"]/g;
    for (const m of contentNoComments.matchAll(re)) {
      const spec = m[1] as string;
      if (!isSameRepoPath(spec)) continue;
      if (isIoBoundaryMock(spec)) continue;
      const line = contentNoComments.slice(0, m.index).split('\n').length;
      errors.push({
        file: rel,
        line,
        detail: `vi.mock('${spec}') 指向同仓业务模块 = 假集成（集成测试必须真实协作，只替身 IO 边界）`,
      });
    }
  }

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

  for (const dir of [join(ROOT, 'src'), join(ROOT, 'tests', 'integration')]) {
    for (const f of collectFiles(dir, /\.test\.(ts|tsx)$/)) {
      const content = readFileSync(f, 'utf-8');
      const rel = relative(ROOT, f).replaceAll('\\', '/');
      const lines = content.split('\n');
      for (const [idx, line] of lines.entries()) {
        if (TAUTOLOGY_PATTERNS.some((p) => p.test(line))) {
          errors.push({
            file: rel,
            line: idx + 1,
            detail: '恒真断言（字面量自比）= 空跑，应断言真实副作用',
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`❌ 测试边界违规 ${errors.length} 处（error）：`);
    for (const e of errors) {
      console.error(`  ${e.file}:${e.line} — ${e.detail}`);
    }
    process.exit(1);
  }
  console.log('✅ 测试边界检查通过');
}

main();
