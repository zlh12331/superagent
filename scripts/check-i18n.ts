import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scanHardcodedZh } from './lib/i18n-hardcoded-scan';

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

/** 扁平化 JSON key（a.b.c）；顶层 $comment（文件说明）不是语言 key，跳过 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (prefix === '' && k === '$comment') continue;
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
    for (const m of line.matchAll(re)) {
      const captured = m[1];
      if (captured !== undefined) direct.push(captured);
    }
    if (/\bt\(\s*[a-zA-Z_$][\w$.]*\s*\)/.test(line)) hasIndirectT = true;
  });
  const used = [...direct];
  if (!hasIndirectT) return { direct, used };
  const keyRe = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){1,4}$/;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of line.matchAll(/['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,4})['"]/g)) {
      const captured = m[1];
      if (captured !== undefined && keyRe.test(captured)) used.push(captured);
    }
  }
  return { direct, used };
}

/** 收集动态模板前缀：t(`chat.${x}`) / t(`settings.appearance.${x}`) → 对应前缀（用于冗余豁免；支持多段前缀） */
function collectDynamicPrefixes(files: string[]): Set<string> {
  const prefixes = new Set<string>();
  const re = /\bt\(\s*`([a-z][\w]*(?:\.[a-z][\w]*)*)\.\$\{/g;
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
 * 2026-09-27 盲区修复：扫描核移至 lib/i18n-hardcoded-scan.ts（oxc-parser AST 主路径 +
 * 正则兜底），覆盖旧逐行正则的三类漏扫——多行 JSX 文本、字符串字面量属性、
 * 表达式容器内字符串；判据细节见该文件头注释，正反自测见其 .test.ts。
 *
 * @param file 渲染层 .tsx/.ts 文件绝对路径
 * @returns 命中描述列表（文件:行号 + 类别 + 片段）；无则空数组
 */
function collectHardcodedZhText(file: string): string[] {
  if (!file.endsWith('.tsx')) return [];
  const rel = relative(ROOT, file).split('\\').join('/');
  if (rel.includes('/test/') || rel.includes('.test.')) {
    return [];
  }
  const content = readFileSync(file, 'utf8');
  return scanHardcodedZh(content).map(
    (hit) => `  ${rel}:${hit.line}  [${hit.kind}] ${hit.snippet}`,
  );
}

function loadLocale(lang: string): { common: Set<string>; errors: Set<string> } {
  const dir = join(LOCALES, lang);
  const common = JSON.parse(readFileSync(join(dir, 'common.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const errors = JSON.parse(readFileSync(join(dir, 'errors.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { common: new Set(flattenKeys(common)), errors: new Set(flattenKeys(errors)) };
}

function main(): number {
  const strict = process.argv.includes('--strict');
  const en = loadLocale('en');
  const zh = loadLocale('zh-CN');
  const problems: string[] = [];

  for (const [name, enSet, zhSet] of [
    ['common', en.common, zh.common],
    ['errors', en.errors, zh.errors],
  ] as const) {
    for (const k of enSet) if (!zhSet.has(k)) problems.push(`en ${name}.${k} 缺失于 zh-CN`);
    for (const k of zhSet) if (!enSet.has(k)) problems.push(`zh-CN ${name}.${k} 缺失于 en`);
  }

  const rendererFiles = walk(RENDERER).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const used = new Set<string>();
  const missing: string[] = [];
  for (const file of rendererFiles) {
    const { direct, used: fileUsed } = collectStaticKeys(file);
    for (const key of fileUsed) used.add(key);
    for (const key of direct) {
      const inCommon = en.common.has(key);
      const inErrors = key.startsWith('errors.') && en.errors.has(key.slice('errors.'.length));
      if (!inCommon && !inErrors) {
        missing.push(`${relative(ROOT, file)}: t('${key}')`);
      }
    }
  }

  const dynamicPrefixes = collectDynamicPrefixes(rendererFiles);
  const unused: string[] = [];
  for (const k of en.common) {
    const dynamic = [...dynamicPrefixes].some((p) => k.startsWith(p));
    const baseKey = k.replace(/_(zero|one|two|few|many|other)$/, '');
    const pluralBase = baseKey !== k && used.has(baseKey);
    if (!used.has(k) && !pluralBase && !dynamic) unused.push(`en common.${k} 未被引用`);
  }

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
    const first = hardcodedText[0] ?? '';
    console.warn(
      `[check-i18n] ⚠️ ${hardcodedText.length} 处 JSX 中文文案未走 t()（--strict 时卡关；建议迁移到 i18n：${first.trim().slice(0, 60)}…）`,
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
