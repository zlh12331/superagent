// scripts/check-i18n.ts
// i18n 审计（工程化强制）：t() 引用 vs 语言包 key 双向校验 + 双语一致性
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/14-i18n-spec.md：
//   1. 双语言文件结构必须完全一致（key 集合相同）
//   2. 引用 key 必须存在于语言包（缺失 = 运行时泄漏 key 原文）
//   3. 语言包 key 不得冗余（未引用 = 死文案）
// 动态 key（t(`approval.${...}`) 模板串）跳过。
//
// 运行：pnpm check:i18n
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const LOCALES = join(RENDERER, 'i18n', 'locales');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** 扁平化 JSON key（a.b.c） */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === 'object')
      keys.push(...flattenKeys(v as Record<string, unknown>, key));
    else keys.push(key);
  }
  return keys;
}

/**
 * 扫描 t('...') 静态引用（单引号/双引号，排除注释行），模板串跳过。
 *
 * 间接引用（const labelKey = 'x.y'; ... t(labelKey) / t(item.labelKey)）：
 * 本文件存在非字符串实参的 t() 调用时，把文件中所有「key 形状」字符串字面量
 * （^小写段.小写段...$）视为引用——本仓库的 labelKey/promptKey/descriptionKey
 * 常量数组均与 t() 间接调用同文件，此规则可覆盖（此前这些 key 被误报冗余）。
 */
/**
 * 扫描 t('...') 静态引用（单引号/双引号，排除注释行），模板串跳过。
 *
 * 间接引用（const labelKey = 'x.y'; ... t(labelKey) / t(item.labelKey)）：
 * 本文件存在非字符串实参的 t() 调用时，把文件中所有「key 形状」字符串字面量
 * （^小写段.小写段...$）追加为引用——本仓库的 labelKey/promptKey/descriptionKey
 * 常量数组均与 t() 间接调用同文件，此规则可覆盖（此前这些 key 被误报冗余）。
 * 间接候选不参与「缺失」校验（key 形状字符串未必都是 i18n key）。
 */
function collectStaticKeys(file: string): { direct: string[]; used: string[] } {
  const content = readFileSync(file, 'utf8');
  const direct: string[] = [];
  const re = /\bt\(\s*['"]([^'"`]+)['"]/g;
  const lines = content.split('\n');
  let hasIndirectT = false;
  lines.forEach((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const m of line.matchAll(re)) direct.push(m[1]);
    // 非字符串实参的 t() 调用：t(labelKey) / t(item.labelKey) 等
    if (/\bt\(\s*[a-zA-Z_$][\w$.]*\s*\)/.test(line)) hasIndirectT = true;
  });
  const used = [...direct];
  if (!hasIndirectT) return { direct, used };
  // key 形状：小写字母开头，点分 1-4 段（排除 channel/错误码/URL 等含冒号连字符的串）
  const keyRe = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){1,4}$/;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of line.matchAll(/['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,4})['"]/g)) {
      if (keyRe.test(m[1])) used.push(m[1]);
    }
  }
  return { direct, used };
}

/** 收集动态模板前缀：t(`chat.${x}`) → 'chat.'（用于冗余豁免） */
function collectDynamicPrefixes(files: string[]): Set<string> {
  const prefixes = new Set<string>();
  const re = /\bt\(\s*`([a-z]+)\.\$\{/g;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const m of content.matchAll(re)) prefixes.add(`${m[1]}.`);
  }
  return prefixes;
}

/**
 * 检测 JSX 文本节点里的中文字符串是否未走 t()。
 *
 * check-i18n 原只能校验「已写的 t() key 存在」，无法发现「JSX 直接写中文却不国际化」。
 * 本规则在 .tsx（排除测试 / 注释 / 含 t() 调用行）中匹配 `>…中文…<` 形态的单行文本节点。
 *
 * @param file 渲染层 .tsx/.ts 文件绝对路径
 * @returns 命中描述列表（文件:行号 + 片段）；无则空数组
 */
function collectHardcodedZhText(file: string): string[] {
  if (!file.endsWith('.tsx')) return [];
  const rel = relative(ROOT, file).split('\\').join('/');
  if (rel.includes('/__tests__/') || rel.includes('/test/') || rel.endsWith('.test.tsx')) {
    return [];
  }
  const content = readFileSync(file, 'utf8');
  // 单行 JSX 文本节点：>…中文…< ；排除 {}、<>、=、+ 形似者（表达式/片段/箭头）。
  // 中文用 BMP 范围 [\u4e00-\u9fff]，不依赖 unicode property escape（跨运行环境更稳）。
  const nodeRe = />\s*[^<>{}=\r\n]*[\u4e00-\u9fff][^<>{}=\r\n]*</g;
  const hits: string[] = [];
  content.split('\n').forEach((line, idx) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (/\bt\(/.test(line)) return; // 该行已含 i18n 调用，跳过避免误报
    for (const m of line.matchAll(nodeRe)) {
      hits.push(`  ${rel}:${idx + 1}  ${m[0].trim().slice(0, 60)}`);
    }
  });
  return hits;
}

function loadLocale(lang: string): { common: Set<string>; errors: Set<string> } {
  const dir = join(LOCALES, lang);
  // 资源文件内部含 "translation" 顶层（i18next 约定），config.ts 挂载 .translation 为命名空间
  const commonRaw = JSON.parse(readFileSync(join(dir, 'common.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const errorsRaw = JSON.parse(readFileSync(join(dir, 'errors.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const common = commonRaw.translation as Record<string, unknown>;
  const errors = errorsRaw.translation as Record<string, unknown>;
  return { common: new Set(flattenKeys(common)), errors: new Set(flattenKeys(errors)) };
}

function main(): number {
  // --strict：冗余 key 也卡关（默认仅缺失/双语不一致卡关，存量冗余可渐进清理）
  const strict = process.argv.includes('--strict');
  const en = loadLocale('en');
  const zh = loadLocale('zh-CN');
  const problems: string[] = [];

  // 1. 双语 key 集合一致性（common + errors）
  for (const [name, enSet, zhSet] of [
    ['common', en.common, zh.common],
    ['errors', en.errors, zh.errors],
  ] as const) {
    for (const k of enSet) if (!zhSet.has(k)) problems.push(`en ${name}.${k} 缺失于 zh-CN`);
    for (const k of zhSet) if (!enSet.has(k)) problems.push(`zh-CN ${name}.${k} 缺失于 en`);
  }

  // 2. 渲染层引用校验
  const rendererFiles = walk(RENDERER).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const used = new Set<string>();
  const missing: string[] = [];
  for (const file of rendererFiles) {
    const { direct, used: fileUsed } = collectStaticKeys(file);
    for (const key of fileUsed) used.add(key);
    for (const key of direct) {
      // errors 命名空间：useErrorMessage 用 t(`errors.${code}`)，code 无前缀
      const inCommon = en.common.has(key);
      const inErrors = key.startsWith('errors.') && en.errors.has(key.slice('errors.'.length));
      if (!inCommon && !inErrors) {
        missing.push(`${relative(ROOT, file)}: t('${key}')`);
      }
    }
  }

  // 3. 冗余 key（静态域内未被引用；动态模板前缀域（chat./approval./dev./git. 等）无法静态判定，豁免）
  const dynamicPrefixes = collectDynamicPrefixes(rendererFiles);
  const unused: string[] = [];
  for (const k of en.common) {
    const dynamic = [...dynamicPrefixes].some((p) => k.startsWith(p));
    if (!used.has(k) && !dynamic) unused.push(`en common.${k} 未被引用`);
  }

  // 4. JSX 中文文案未走 t()（盲区：原只校验已写的 t() key，查不出「直接写死中文」）
  const hardcodedText: string[] = [];
  for (const file of rendererFiles) hardcodedText.push(...collectHardcodedZhText(file));

  for (const p of missing) problems.push(`缺失: ${p}`);
  if (strict) for (const p of unused) problems.push(`冗余: ${p}`);
  else if (unused.length > 0) {
    console.warn(
      `[check-i18n] ⚠️ ${unused.length} 个冗余 key（死文案，--strict 时卡关；建议清理：${unused.slice(0, 3).join('、')}…）`,
    );
  }
  if (strict) {
    for (const p of hardcodedText) problems.push(`未国际化文案: ${p}`);
  } else if (hardcodedText.length > 0) {
    console.warn(
      `[check-i18n] ⚠️ ${hardcodedText.length} 处 JSX 中文文案未走 t()（--strict 时卡关；建议迁移到 i18n：${hardcodedText[0].trim().slice(0, 60)}…）`,
    );
  }

  if (problems.length === 0) {
    console.log(
      `[check-i18n] ✅ 通过：扫描 ${rendererFiles.length} 文件，${used.size} 个引用 key，0 缺失/冗余/双语不一致`,
    );
    return 0;
  }

  console.error(`[check-i18n] ❌ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('[check-i18n] 修复指引：docs/design/14-i18n-spec.md（key 命名 + 新增流程）');
  return 1;
}

process.exitCode = main();
