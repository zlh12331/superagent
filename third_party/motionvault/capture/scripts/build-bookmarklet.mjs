/**
 * build-bookmarklet.mjs —— 把 bookmarklet 入口打成单文件 IIFE，并生成可粘贴的 bookmarklet URL。
 * 用法：node capture/scripts/build-bookmarklet.mjs（在仓库根或 capture/ 下均可）
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const captureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(captureDir, 'src/shell/bookmarklet/index.ts');
const distDir = path.join(captureDir, 'dist');
const outfile = path.join(distDir, 'motionlens.bookmarklet.js');
const urlfile = path.join(distDir, 'bookmarklet-url.txt');

await mkdir(distDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  outfile,
  logLevel: 'warning',
});

const bundle = await readFile(outfile, 'utf8');
const kb = (bundle.length / 1024).toFixed(1);

// bookmarklet URL：bundle 已是 IIFE，嵌套进 void(function(){...})()，
// void 确保表达式求值为 undefined，避免浏览器把返回值当文档内容导航。
const bookmarkletUrl = `javascript:void(function(){${bundle}})()`;
await writeFile(urlfile, bookmarkletUrl, 'utf8');

console.log(`✔ dist/motionlens.bookmarklet.js  ${kb} KB (minified)`);
console.log(`✔ dist/bookmarklet-url.txt        ${(bookmarkletUrl.length / 1024).toFixed(1)} KB URL`);
if (result.warnings.length) console.warn(result.warnings);
