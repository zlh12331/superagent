import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 仓库根（本脚本位于 scripts/ 下） */
const ROOT = join(import.meta.dirname, '..');

/** 不扫描的目录（构建产物 / 依赖 / 本地产物 / vendored 第三方） */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  '.tmp',
  '.electron-user-data',
  '.e2e-user-data',
  'out',
  'release',
  'third_party',
  'stats',
  'playwright-report',
  'playwright-report-electron',
  'playwright-report-smoke',
  'test-results',
]);

/**
 * 豁免清单：脚本名 → 理由
 *
 * 仅在「文档按设计描述的不是当前 package.json 的脚本」时使用，
 * 且必须写明理由。空对象表示当前无豁免。
 */
export const EXEMPT: Readonly<Record<string, string>> = {};

/** 一处问题 */
export interface Issue {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/** 递归收集 .md 文件（相对仓库根，POSIX 分隔符） */
export function collectMarkdownFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

/** 拆一行 markdown 表格为单元格（去掉首尾空段并 trim） */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return [];
  }
  const parts = trimmed.split(/(?<!\\)\|/);
  return parts.slice(1, -1).map((c) => c.trim());
}

/** 是否为表头下的分隔行（`|---|---|` / `|:--:|` 等） */
export function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** 去掉单元格的反引号包裹，并把表格必需的 `\|` 转义还原 */
export function unquote(cell: string): string {
  const m = /^`(.*)`$/.exec(cell);
  const body = m?.[1] ?? cell;
  return body.replaceAll('\\|', '|');
}

/** 扫描单个文件的文本，返回问题列表 */
export function checkText(
  text: string,
  file: string,
  scripts: Readonly<Record<string, string>>,
): Issue[] {
  const issues: Issue[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    if (current === undefined || !isSeparatorRow(current)) {
      continue;
    }
    const headerLine = lines[i - 1];
    if (headerLine === undefined) {
      continue;
    }
    const header = splitRow(headerLine);
    if (unquote(header[0] ?? '') !== '脚本') {
      continue;
    }
    const compareCommand = unquote(header[1] ?? '') === '命令';

    for (let j = i + 1; j < lines.length; j += 1) {
      const rowLine = lines[j];
      if (rowLine === undefined || !rowLine.trim().startsWith('|')) {
        break;
      }
      const cells = splitRow(rowLine);
      const name = unquote(cells[0] ?? '');
      if (name === '') {
        continue;
      }
      const lineNo = j + 1;
      if (name in EXEMPT) {
        continue;
      }
      const actual = scripts[name];
      if (actual === undefined) {
        issues.push({
          file,
          line: lineNo,
          detail: `脚本不存在：\`${name}\`（package.json 中无此脚本）`,
        });
        continue;
      }
      if (!compareCommand) {
        continue;
      }
      const documented = unquote(cells[1] ?? '');
      if (documented !== actual) {
        issues.push({
          file,
          line: lineNo,
          detail:
            `\`${name}\` 命令不符：\n` + `      文档：${documented}\n` + `      实际：${actual}`,
        });
      }
    }
  }
  return issues;
}

function main(): void {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const table = scripts.scripts ?? {};

  const files = collectMarkdownFiles();
  const issues: Issue[] = [];
  for (const file of files) {
    issues.push(...checkText(readFileSync(join(ROOT, file), 'utf8'), file, table));
  }

  if (issues.length === 0) {
    console.log(`[check-docs-scripts] ✅ 通过：${files.length} 个 md，脚本表与 package.json 一致`);
    return;
  }

  console.error(`[check-docs-scripts] ❌ ${issues.length} 处文档脚本表与 package.json 不符：`);
  for (const issue of issues) {
    console.error(`  ${issue.file}:${issue.line}  ${issue.detail}`);
  }
  console.error('');
  console.error('  处置：更新文档使其与 package.json 一致；若文档是按设计描述而非现状，');
  console.error('  在 scripts/check-docs-scripts.ts 的 EXEMPT 中登记并写明理由。');
  process.exit(1);
}

main();
