// scripts/patch-memory-engine.mjs
// 上游补丁通道（导出 / 重放 / 回滚）
// ──────────────────────────────────────────────────────────────
// 背景：packages/memory-engine/MemoryCore 是 vendored 第三方源码。
//   直接修改会被 memory-engine:integrity 拦下；改动必须走补丁：
//   - export：把当前 MemoryCore 相对锚点的改动导出为 patches/NNNN-<name>.patch
//   - apply ：重放 patches/ 下全部补丁（sync 会自动调用）
//   - reset ：把 MemoryCore 恢复到锚点状态（丢弃未导出改动）
//
// 实现说明：用 `git diff --no-index` 产出补丁、`git apply` 重放——
//   依赖仓库内已有 git，无需额外依赖。
//
// 用法：
//   node scripts/patch-memory-engine.mjs export <name>
//   node scripts/patch-memory-engine.mjs apply
//   node scripts/patch-memory-engine.mjs reset
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENGINE_DIR = join(ROOT, 'packages', 'memory-engine');
const CORE = join(ENGINE_DIR, 'MemoryCore');
const PATCH_DIR = join(ENGINE_DIR, 'patches');

function fail(msg) {
  console.error(`[memory-engine:patch] ❌ ${msg}`);
  process.exit(1);
}

function patches() {
  return existsSync(PATCH_DIR)
    ? readdirSync(PATCH_DIR)
        .filter((f) => f.endsWith('.patch'))
        .sort()
    : [];
}

/** 从 git 远端锚点重建一份"纯净"源码到临时目录（作为 diff 基线） */
function extractBaseline() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-engine-baseline-'));
  const res = spawnSync('git', ['stash', 'list'], { cwd: ROOT, encoding: 'utf8' });
  void res;
  // 用 git show 取当前 HEAD 的 MemoryCore（HEAD 即锚点，因为改动尚未提交时
  // 也会被 integrity 拦下，故此处假设 HEAD 是干净的锚点）
  const archive = spawnSync('git', ['archive', 'HEAD', 'packages/memory-engine/MemoryCore'], {
    cwd: ROOT,
    encoding: 'buffer',
  });
  if (archive.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    fail('无法从 HEAD 提取基线（packages/memory-engine/MemoryCore 未提交？）');
  }
  // 解开 tar 到临时目录
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (tar.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    fail('解包基线失败（需要系统 tar）');
  }
  return { dir, baselineCore: join(dir, 'packages', 'memory-engine', 'MemoryCore') };
}

const action = process.argv[2];

if (action === 'export') {
  const name = process.argv[3];
  if (name === undefined || name.trim().length === 0) {
    fail('用法：node scripts/patch-memory-engine.mjs export <name>');
  }
  const { dir, baselineCore } = extractBaseline();
  const seq = String(patches().length + 1).padStart(4, '0');
  const outFile = join(PATCH_DIR, `${seq}-${name}.patch`);
  const diff = spawnSync(
    'git',
    ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', baselineCore, CORE],
    { encoding: 'utf8' },
  );
  // git diff --no-index 有差异时返回 1，属预期
  const out = (diff.stdout ?? '').replaceAll(baselineCore.replace(/\\/g, '/'), 'MemoryCore');
  if (out.trim().length === 0) {
    rmSync(dir, { recursive: true, force: true });
    fail('没有检测到改动——MemoryCore 与锚点一致');
  }
  writeFileSync(outFile, out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  console.log(`[memory-engine:patch] ✅ 已导出：patches/${seq}-${name}.patch`);
  console.log('  请同时在 packages/memory-engine/patches/README.md 的登记表补充一行。');
  process.exit(0);
}

if (action === 'apply') {
  const list = patches();
  if (list.length === 0) {
    console.log('[memory-engine:patch] 无补丁需要重放');
    process.exit(0);
  }
  for (const p of list) {
    const res = spawnSync('git', ['apply', '--3way', join(PATCH_DIR, p)], {
      cwd: CORE,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(res.stdout);
      console.error(res.stderr);
      fail(`补丁重放失败：${p}`);
    }
    console.log(`  ✓ ${p}`);
  }
  console.log(`[memory-engine:patch] ✅ 已重放 ${list.length} 个补丁`);
  process.exit(0);
}

if (action === 'reset') {
  const { dir, baselineCore } = extractBaseline();
  rmSync(CORE, { recursive: true, force: true });
  cpSync(baselineCore, CORE, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  console.log('[memory-engine:patch] ✅ MemoryCore 已恢复到锚点状态（未导出改动已丢弃）');
  process.exit(0);
}

fail('用法：node scripts/patch-memory-engine.mjs <export <name> | apply | reset>');
