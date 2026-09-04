// scripts/generate-build-info.mjs
// 生成构建信息 resources/build-info.json（「关于」页渠道/构建时间/Commit 数据源）
// ──────────────────────────────────────────────────────────────
// 用途：发布构建（build:dist/win/mac/linux）前置，把版本/渠道/源码哈希/构建时间
// 写入 resources/build-info.json；electron-builder extraResources 会把它打进安装包
// （resources/build-info.json），主进程 app:getInfo 读取展示。
// dev 直跑不执行本脚本：主进程 readBuildInfo 回退 channel='dev'。
// 失败策略：非致命（打 warn），缺失时关于页仅不显示构建信息。
// ──────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 取短提交哈希（非 git 环境/未提交时返回 undefined） */
function shortSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** 渠道：构建产物打包用 BUILD_CHANNEL 环境变量；未指定默认 stable */
const channel = process.env.BUILD_CHANNEL ?? 'stable';
const version = process.env.npm_package_version ?? '0.0.0';
const buildTime = new Date().toISOString();
const commitSha = shortSha();

const info = {
  version,
  channel,
  ...(commitSha !== undefined ? { commitSha } : {}),
  buildTime,
};

const outDir = join(root, 'resources');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'build-info.json');
writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
console.log(`[build-info] ${outFile} → ${JSON.stringify(info)}`);
