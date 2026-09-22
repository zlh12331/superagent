// scripts/check-secrets-git.ts
// 密钥扫描闸（只扫已提交内容，模式 gitleaks git）
// ──────────────────────────────────────────────────────────────
// 扫描范围：默认 `<远端主分支>..HEAD`，即「本次相对远端 main 多出来的提交」。
// 这个范围正好对应「即将推送 / 即将并入 main 的东西」，且实测约 1.4 秒。
//
// 为什么用 `gitleaks git` 而不是 `gitleaks dir .`（2026-09-22 实测）：
//   `dir .` 扫文件系统，会连同 .pnpm-store / .electron-user-data / .env 等
//   非版本库内容一起扫（实测 3.21 GB / 191 秒 / 451 条噪音命中）；
//   `git` 只扫已提交内容（实测 26 MB：全历史 1 分 41 秒、区间 1.4 秒）。
//   两者规则集相同（同读 .gitleaks.toml），差异只在范围。
//
// 基线缺失时（全新克隆、从未 fetch）回退全历史扫描——慢但不会漏，属 fail-closed。
//
// ⚠️ 配置侧前提：.gitleaks.toml 必须有 `[extend] useDefault = true`。
//    缺它则 gitleaks 用该文件**替代**内置规则集，而文件里只有 [allowlist]、
//    没有 [[rules]] ⇒ 有效规则数为 0 ⇒ 恒报 no leaks found（2026-09-22 前
//    长期如此，三道 gitleaks 闸全部空转）。
// ──────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';

/** 默认基线：远端主分支名（可用首个参数覆盖，如 `tsx … origin/beta`） */
const DEFAULT_BASE_REF = 'origin/main';

/** 取指定 ref 的 SHA；不存在返回 null */
export function resolveRef(ref: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
  const sha = (r.stdout ?? '').trim();
  return r.status === 0 && sha !== '' ? sha : null;
}

/** 组装 gitleaks 参数（基线存在则限定区间，否则全历史） */
export function buildArgs(baseSha: string | null): string[] {
  const args = ['git', '.', '--config', '.gitleaks.toml', '--redact', '--no-banner'];
  if (baseSha !== null) {
    args.push('--log-opts', `${baseSha}..HEAD`);
  }
  return args;
}

function main(): void {
  const baseRef = process.argv[2] ?? DEFAULT_BASE_REF;
  const baseSha = resolveRef(baseRef);

  if (baseSha !== null) {
    console.log(`[check-secrets-git] 扫描 ${baseRef}..HEAD（${baseSha.slice(0, 8)}..HEAD）`);
  } else {
    console.warn(`[check-secrets-git] ⚠️ 未找到 ${baseRef}，回退全历史扫描（较慢）`);
  }

  const r = spawnSync('gitleaks', buildArgs(baseSha), { stdio: 'inherit' });
  if (r.error !== undefined) {
    console.error(`[check-secrets-git] ❌ 无法执行 gitleaks：${String(r.error)}`);
    console.error('  安装：https://github.com/gitleaks/gitleaks#installing');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[check-secrets-git] ❌ 检出疑似密钥，推送/合并前必须处理（密钥只能作废重签）。');
    process.exit(1);
  }
}

main();
