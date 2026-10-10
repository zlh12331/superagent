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
