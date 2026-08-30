// scripts/lib/file-metrics.ts
// 文件体积度量纯函数：原始行数 + 净行数 + 扫描集收集（供 check-file-size / 门禁复用）
// ──────────────────────────────────────────────────────────────
// 为什么两种口径都要测（2026-08-30 审计结论）：
// 只测净行会为「注释刷量」开门——service-container.ts 原始 1080 行被压到
// 503 净行（注释密度 49%）而「通过 600 净行门槛」；净行同时奖励了
// 「把该拆的文件写成注释文档」。原始行数是可文件化沟通的硬上限
// （业界 eslint max-lines 默认口径即原始行），两者互补，缺一不可。
// ──────────────────────────────────────────────────────────────

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 目录遍历时需要跳过的目录名（产物 / 依赖 / 生成物 / 参考代码） */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  'out',
  'dist',
  'build',
  'coverage',
  '.vite',
  // 外部参考代码（未入仓，39,625 文件）——所有自研门禁必须排除
  '_template',
]);

/** 按目录名切分并去掉文件末尾的空行（等价 wc -l 口径） */
export function splitLines(source: string): string[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * 统计单个文件的行数指标
 *
 * @param source 文件内容
 * @returns raw = 非空行以外的全部物理行；net = 去掉空行与纯注释行
 */
export function measureLines(source: string): { raw: number; net: number } {
  const lines = splitLines(source);
  let inBlockComment = false;
  let net = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('*')) continue;
    net++;
  }
  return { raw: lines.length, net };
}

/** 是否为受门禁管辖的源文件（.ts/.tsx，排除测试与类型声明） */
export function isSourceFile(name: string): boolean {
  if (!(name.endsWith('.ts') || name.endsWith('.tsx'))) return false;
  if (name.includes('.test.')) return false;
  return true;
}

/**
 * 递归收集待审计文件（绝对路径）
 *
 * @param dir 起始目录（不存在时返回空集，方便 packages/* 动态发现）
 * @param acc 累加器
 */
export function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (isSourceFile(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * 发现 packages 下各包的 src 目录（契约层同样受体积门禁管辖）
 *
 * @param root 仓库根
 * @returns 存在的 src 目录绝对路径列表
 */
export function discoverPackageSrcDirs(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, 'packages'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIR_NAMES.has(e.name))
    .map((e) => join(root, 'packages', e.name, 'src'))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true);
}

/**
 * 计算单个文件的体积指标（含相对路径）
 *
 * @param root 仓库根（用于生成报告用的相对路径）
 * @param file 文件绝对路径
 * @returns path（posix 相对路径）+ raw/net
 */
export function measureFile(
  root: string,
  file: string,
): { path: string; raw: number; net: number } {
  return { path: toPosixRelative(root, file), ...measureLines(readFileSync(file, 'utf8')) };
}

/**
 * 体积超限判定：原始行或净行任一口径超限即违规（两条口径互补，缺一即可被绕过）
 *
 * @param metrics 实测 raw/net
 * @param rawLimit 原始行上限
 * @param netLimit 净行上限
 */
export function isViolating(
  metrics: { raw: number; net: number },
  rawLimit: number,
  netLimit: number,
): boolean {
  return metrics.raw > rawLimit || metrics.net > netLimit;
}

/** Windows 反斜杠 → posix 斜杠（基线文件跨平台一致） */
export function toPosixRelative(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}
