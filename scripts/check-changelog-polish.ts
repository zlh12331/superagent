// check-changelog-polish.ts：CHANGELOG 润色门禁——版本段仍是机器原文即失败，拦「Release PR 未润色就合并 / 未润色就打 tag」。
// 为什么需要：release-please 以 commit 为粒度产出 CHANGELOG，项目又走 squash 合并 ⇒ 一个含几十个修复的 PR
// 在 CHANGELOG 里只剩一行 PR 标题，用户能感知的改动全部不可见；润色（RELEASING.md §2.1）纯靠人工，
// 没有门禁时漏做不会被任何环节发现。
// 接入两处：.github/workflows/ci.yml 的 quality job（仅 release-please-- 前缀分支，借既有必需检查获得合并阻塞力）
// 与 .github/workflows/release.yml 的 gate job（打 tag 前兜底，未润色即失败、不占版本号）。
// 判定口径与豁免标记在 scripts/lib/changelog-polish.ts；本文件只管参数解析、定位版本段与失败指引输出，入口 pnpm check:changelog-polish。
import { readFileSync } from 'node:fs';

import {
  needsPolish,
  POLISH_MARKER,
  parseVersionSections,
  sectionText,
  type VersionSection,
} from './lib/changelog-polish';

// ───── 输入：CLI 参数与 CHANGELOG 原文（路径写死，不开放外部传入）─────
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

// ───── 门禁判定与输出：定位目标版本段 → 需润色则打印润色指引并退出 ─────
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

/** 门禁入口（CI 直接调用）：结论由退出码表达——0 = 已润色或按「跳过」处理，1 = 参数非法 / 版本段不存在 / 需润色 */
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
