// scripts/check-secrets-git.ts
// 密钥扫描闸（gitleaks git 模式）：默认扫 origin/main..HEAD——正好是「即将推送/
// 并入 main 的内容」，实测 ~1.4s。不用 `gitleaks dir .`：那会连 .pnpm-store/
// .electron-user-data 等非版本库内容一起扫（实测 3.21GB/191s/451 条噪音）
// 基线缺失（全新克隆）回退全历史——慢但不漏，fail-closed
// ⚠️ 配置前提：.gitleaks.toml 必须有 [extend] useDefault = true，否则内置规则集
// 被替代、有效规则数为 0、恒报 no leaks found（2026-09-22 前三道闸全空转）

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
