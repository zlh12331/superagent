// scripts/sentry-release.mjs
// Sentry release 管理（R2 修复）
// ──────────────────────────────────────────────────────────────
// 此前 package.json 脚本硬编码 --release code-agent@1.0.0：版本号不随 tag 演进，
// 上传的符号永远挂在 1.0.0 名下。现改为从 package.json 动态读取版本。
// 用法（替代原 sentry:release:new / sentry:upload:symbols）：
//   node scripts/sentry-release.mjs new      # 创建 release
//   node scripts/sentry-release.mjs upload   # 上传 main + renderer 符号
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const release = `code-agent@${pkg.version}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(args) {
  const result = spawnSync(pnpm, ['sentry-cli', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  return result.status ?? 0;
}

const action = process.argv[2];
if (action === 'new') {
  process.exit(run(['releases', 'new', release]));
}
if (action === 'upload') {
  const main = run([
    'sourcemaps',
    'upload',
    '--org',
    'sentry',
    '--project',
    'electron',
    '--release',
    release,
    '--url-prefix',
    'app:///out/',
    './out',
  ]);
  if (main !== 0) process.exit(main);
  process.exit(
    run([
      'sourcemaps',
      'upload',
      '--org',
      'sentry',
      '--project',
      'electron',
      '--release',
      release,
      '--url-prefix',
      'app:///renderer/',
      './out/renderer',
    ]),
  );
}

console.error('用法：node scripts/sentry-release.mjs <new|upload>');
process.exit(1);
