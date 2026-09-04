/**
 * run-tests.mjs —— Node 20 兼容的测试 runner。
 *
 * `node --test --experimental-strip-types` 需要 Node 22.6+；本脚本用 esbuild
 * 把 test/*.test.ts 预编译为 test/.build/*.mjs，与 test/*.test.mjs（原地运行，
 * 保证其内部基于 __dirname 的相对路径仍然有效）一起交给 `node --test`，退出码透传。
 *
 * e2e / smoke 脚本（bookmarklet.e2e.mjs、extension.smoke.mjs）依赖 playwright
 * 与预构建产物，不属于单元测试，不在此运行。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');
const outDir = join(testDir, '.build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(testDir).filter(
  (f) => f.endsWith('.test.ts') || f.endsWith('.test.mjs'),
);
if (entries.length === 0) {
  console.error('run-tests: no test files found in test/');
  process.exit(1);
}

const testFiles = [];
for (const file of entries) {
  const src = join(testDir, file);
  if (file.endsWith('.test.mjs')) {
    // .mjs 原地运行：analyze.test.mjs 依赖 __dirname/../src 的相对路径
    testFiles.push(src);
    continue;
  }
  const out = join(outDir, file.replace(/\.test\.ts$/, '.test.mjs'));
  await build({
    entryPoints: [src],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // node:test / node:assert 等内建模块保持外部引用
    packages: 'external',
    logLevel: 'silent',
  });
  testFiles.push(out);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
