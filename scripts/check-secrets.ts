// scripts/check-secrets.ts
// 密钥硬编码扫描（工程化强制）：禁止在源码中提交真实密钥/令牌
// ──────────────────────────────────────────────────────────────
// 依据 17-security-spec.md §密钥纪律 + typescript-dev-standards-ai.md §安全。
// 检测模式：
//   A. 已知令牌前缀（sk- / ghp_ / xoxb- 等）
//   B. 赋值语句中的疑似密钥（api_key / secret / password / token = '长字符串'）
// 排除：测试文件（fake token）、mock 数据、注释行、.env（gitignore 保护）。
//
// 运行：pnpm check:secrets
// ──────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'scripts')];

// A. 已知密钥前缀（OpenAI/Anthropic/GitHub/Slack 等常见格式）
const TOKEN_PREFIX_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})\b/g;

// B. 赋值语句疑似密钥：key = '8+ 字符'（排除占位符/示例）
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|secret|secret_key|password|passwd|client_secret|access_token|auth_token|private_key)\s*[:=]\s*['"]([^'"]{8,})['"]/gi;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'test')
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (
      entry.name.endsWith('.ts') ||
      entry.name.endsWith('.tsx') ||
      entry.name.endsWith('.mjs') ||
      entry.name.endsWith('.cjs')
    ) {
      // 测试与 mock 文件豁免（fake token）
      if (entry.name.includes('.test.') || entry.name.includes('mock')) continue;
      acc.push(full);
    }
  }
  return acc;
}

function isPlaceholder(value: string): boolean {
  return /^(xxx|your|example|placeholder|dummy|test|changeme|\.\.\.|REPLACE_ME|fake|mock)/i.test(
    value,
  );
}

function checkFile(file: string, findings: Finding[]): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const lineNo = idx + 1;

    for (const m of line.matchAll(TOKEN_PREFIX_RE)) {
      findings.push({
        file: rel,
        line: lineNo,
        rule: 'token-prefix',
        detail: `${m[0].slice(0, 12)}…（疑似真实令牌）`,
      });
    }
    for (const m of line.matchAll(ASSIGNMENT_RE)) {
      if (!isPlaceholder(m[2])) {
        findings.push({
          file: rel,
          line: lineNo,
          rule: 'secret-assignment',
          detail: `${m[1]} = '${m[2].slice(0, 8)}…'（疑似硬编码密钥）`,
        });
      }
    }
  });
}

function main(): number {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(d));
  const findings: Finding[] = [];
  for (const file of files) checkFile(file, findings);

  if (findings.length === 0) {
    console.log(`[check-secrets] ✅ 通过：${files.length} 文件，0 硬编码密钥`);
    return 0;
  }

  console.error(`[check-secrets] ❌ ${findings.length} 处疑似密钥（17-security-spec §密钥纪律）：`);
  for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.detail}`);
  console.error(
    '[check-secrets] 修复指引：密钥走 safeStorage 加密存储 / .env；测试用显式 fake 值（如 "fake-token"）',
  );
  return 1;
}

process.exitCode = main();
