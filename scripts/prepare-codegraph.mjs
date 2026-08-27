// scripts/prepare-codegraph.mjs
// 生成 resources/codegraph/（@colbymchenry/codegraph 平台捆绑包）
// ──────────────────────────────────────────────────────────────
// 背景：codebase 工具（Agent 代码库智能查询）经 spawn 调用 codegraph CLI。
//   @colbymchenry/codegraph 以 optionalDependencies 分发各平台捆绑包
//   （vendored Node 24 + app，esbuild 同款模式），pnpm 装入
//   node_modules/.pnpm/@colbymchenry+codegraph-<platform>-<arch>@*/。
//   打包环境需把当前平台捆绑包部署到 resources/codegraph/，经
//   electron-builder extraResources 拷到 process.resourcesPath/codegraph，
//   CodebaseService.resolveCodegraphBundle 按平台选择 node.exe 或 bin/codegraph。
//
// 用法：node scripts/prepare-codegraph.mjs
// ──────────────────────────────────────────────────────────────

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = `${process.platform}-${process.arch}`;
const PREFIX = `@colbymchenry+codegraph-${TARGET}@`;

const pnpmRoot = join(ROOT, 'node_modules', '.pnpm');
if (!existsSync(pnpmRoot)) {
  console.error(`[prepare-codegraph] 未找到 pnpm store：${pnpmRoot}`);
  process.exit(1);
}
const candidates = readdirSync(pnpmRoot)
  .filter((n) => n.startsWith(PREFIX))
  .sort();
const latest = candidates.at(-1);
if (latest === undefined) {
  console.error(
    `[prepare-codegraph] codegraph 平台捆绑包未安装（${TARGET}）——请先执行 pnpm add @colbymchenry/codegraph`,
  );
  process.exit(1);
}
const src = join(pnpmRoot, latest, 'node_modules', '@colbymchenry', `codegraph-${TARGET}`);
const dest = join(ROOT, 'resources', 'codegraph');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[prepare-codegraph] ${TARGET} 捆绑包已部署 → resources/codegraph/`);
