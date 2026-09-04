/**
 * build-extension.mjs —— 打包 Chrome MV3 扩展到 capture/dist/extension/。
 * 三次 esbuild：content.ts(iife) / background.ts(esm) / popup.ts+library.ts(iife)，
 * 再拷贝 manifest.json（version 取 capture/package.json）、popup.html、library.html、icons/。
 * 用法：node capture/scripts/build-extension.mjs
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const captureRoot = join(here, '..');
const srcDir = join(captureRoot, 'src/shell/extension');
const outDir = join(captureRoot, 'dist/extension');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome110',
  logLevel: 'info',
  outdir: outDir,
};

// 1) content script：iife（executeScript 以经典脚本注入）
await build({
  ...common,
  entryPoints: [join(srcDir, 'content.ts')],
  format: 'iife',
});

// 2) service worker：esm（manifest background.type = module）
await build({
  ...common,
  entryPoints: [join(srcDir, 'background.ts')],
  format: 'esm',
});

// 3) popup + library 页面脚本：iife
await build({
  ...common,
  entryPoints: [join(srcDir, 'popup.ts'), join(srcDir, 'library.ts')],
  format: 'iife',
});

// manifest：version 从 capture/package.json 读取
const pkg = JSON.parse(readFileSync(join(captureRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 静态资源
for (const f of ['popup.html', 'library.html']) {
  cpSync(join(srcDir, f), join(outDir, f));
}
cpSync(join(srcDir, 'icons'), join(outDir, 'icons'), { recursive: true });

// 产物清单
console.log('\n—— 产物清单 dist/extension/ ——');
function walk(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, `${prefix}${name}/`);
    else console.log(`  ${prefix}${name}  ${(st.size / 1024).toFixed(1)} KB`);
  }
}
walk(outDir);
console.log(`\n构建完成：${relative(process.cwd(), outDir)}`);
