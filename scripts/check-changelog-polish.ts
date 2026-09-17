// scripts/check-changelog-polish.ts
// CHANGELOG 润色门禁 · 拦「Release PR 忘润色就合并」
// ──────────────────────────────────────────────────────────────
// 为什么需要：release-please 以 commit 为粒度产出 CHANGELOG，项目走 squash 合并，
// 于是一个含几十个修复的 PR 在 CHANGELOG 里只剩一行 PR 标题——里面用户能感知的
// 改动全部不可见。RELEASING.md 要求「发版前在 Release PR 中人工润色」，但该步骤
// 此前无任何机制看守，漏做不会被发现（2026-09-17 实测漏做 v1.1.1）。
//
// 本门禁接入两处，形成闭环（详见 RELEASING.md）：
//   1. ci.yml 的 quality job——仅对 Release PR（head_ref 前缀 release-please--）执行，
//      利用既有必需检查获得合并阻塞力，无需新增 ruleset 条目。
//   2. release.yml 的 gate job——发版打 tag 前兜底；未润色则 gate 失败，
//      不占版本号、可重试。
//
// 判定与豁免规则见 scripts/lib/changelog-polish.ts 的头注释。
//
// 运行：
//   pnpm check:changelog-polish                     # 检查最新版本段
//   tsx scripts/check-changelog-polish.ts --version 1.1.1
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

import {
  needsPolish,
  POLISH_MARKER,
  parseVersionSections,
  sectionText,
  type VersionSection,
} from './lib/changelog-polish';

/** 固定只检查仓库根下的 CHANGELOG.md（不开放路径参数，避免任意路径读取面） */
const CHANGELOG_FILE = 'CHANGELOG.md';

interface Options {
  /** 指定检查的版本号；null 表示取最新（首个）版本段 */
  readonly version: string | null;
}

/** 解析 CLI 参数（未知参数直接失败，避免静默走默认行为） */
function parseArgs(argv: readonly string[]): Options {
  let version: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      version = argv[index + 1] ?? null;
      index += 1;
    } else {
      console.error(`[check-changelog-polish] ❌ 未知参数：${String(arg)}`);
      process.exit(1);
    }
  }
  return { version };
}

/** 读取仓库根下的 CHANGELOG；缺失返回 null（由调用方决定跳过） */
function readChangelog(): string | null {
  try {
    return readFileSync(CHANGELOG_FILE, 'utf-8');
  } catch {
    return null;
  }
}

/** 定位待检查的版本段 */
function pickSection(
  sections: readonly VersionSection[],
  version: string | null,
): VersionSection | null {
  if (version === null) {
    return sections[0] ?? null;
  }
  return sections.find((section) => section.version === version) ?? null;
}

/** 输出失败指引并结束进程（内容面向「正在合并 Release PR 的人」） */
function failWithGuidance(section: VersionSection): never {
  console.error(
    `[check-changelog-polish] ❌ CHANGELOG 的 ${section.version} 段仍是机器原文，未润色。`,
  );
  console.error('');
  console.error('  release-please 只能输出「一个 squash 提交 = 一行标题」，');
  console.error('  用户在 Release 页面看不到本次真正的改动。请改写为面向用户的文案：');
  console.error('');
  console.error('  1. 生成底稿：pnpm release:draft');
  console.error(
    `  2. 按底稿改写 ${CHANGELOG_FILE} 的 ${section.version} 段（说清「用户得到什么」，`,
  );
  console.error('     内部工程改动可归入「内部改进」或略去）');
  console.error('  3. 重跑本检查：pnpm check:changelog-polish');
  console.error('');
  console.error(`  确实要直接使用机器原文时，在该版本段内加一行 ${POLISH_MARKER} 显式放行。`);
  process.exit(1);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const markdown = readChangelog();
  if (markdown === null) {
    console.log(`[check-changelog-polish] 跳过：未找到 ${CHANGELOG_FILE}`);
    return;
  }

  const sections = parseVersionSections(markdown);
  if (sections.length === 0) {
    console.log(`[check-changelog-polish] 跳过：${CHANGELOG_FILE} 中无版本段`);
    return;
  }

  const target = pickSection(sections, options.version);
  if (target === null) {
    console.error(
      `[check-changelog-polish] ❌ ${CHANGELOG_FILE} 中未找到版本段 ${options.version ?? '(最新)'}`,
    );
    console.error(`  现有版本段：${sections.map((s) => s.version).join(', ')}`);
    process.exit(1);
  }

  if (needsPolish(sectionText(markdown, target))) {
    failWithGuidance(target);
  }
  console.log(`[check-changelog-polish] ✅ ${target.version} 版本段已润色（或已显式放行）`);
}

main();
