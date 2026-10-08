// scripts/check-release-anchor.ts
// 发版锚点自洽检查（护栏 B，2026-10-05 落地）
// ──────────────────────────────────────────────────────────────
// 背景：1.6.x 发版连环事故（2026-10-05）——Release PR 合并时 CD 打包失败 →
//   tag 缺失，但 manifest 已推进、label 已收尾 tagged → release-please 三态
//   （tag ↔ manifest ↔ Release PR）不一致，版本推导回退全量历史（#80/#87 两次
//   误开、1.6.0 被消费、版本链跳到 1.6.1）。
//
// 职责：校验三态自洽，不一致或**无法核验**即 fail-closed（exit 1）。
//   - pre-merge（默认）：合并 Release PR **之前**跑（RELEASING.md §7.1 人工步骤 +
//     ci.yml quality 的「Release PR gates」自动执行）——最近已合并 Release PR
//     必须收尾 tagged 且对应 tag 存在；open 的 Release PR 版本必须严格大于
//     lastReleased。
//   - post-merge：release.yml gate 在打 tag 前跑——断言 manifest 已推进到该版本
//     且 tag 尚不存在（重跑挪 tag 事故形态，见 RELEASING.md §5）。刚合并的
//     Release PR 停在 autorelease: pending 属合法状态（label 收尾在 release job
//     末尾），故 gate 不能用 pre-merge 模式（会对每次发版误报）。
//
// 网络（2026-10-06 收口）：网络失败一律 fail-closed 计 ❌——首版 catch 静默跳过
//   落入「近期无 Release PR（正常）」分支，与头部 fail-closed 宣称矛盾，且发版
//   事故场景（GitHub API 抖动）恰是本检查最该工作的时候。404 → null 的「不存在」
//   合法路径不受影响。
//
// 实现（Mimosa 门禁对齐）：零子进程——Node 原生 fetch 直连 GitHub REST API，
//   SSRF 防线在 scripts/lib/github-rest.ts（host 白名单 + path 前缀锚定）。
//   认证：GITHUB_TOKEN 环境变量（只读公开数据也可匿名，但低限流；CI 必配）。
//
// 用法：
//   pnpm check:release-anchor                        # pre-merge，校验 manifest 当前版本
//   pnpm check:release-anchor --version 1.6.2        # 显式指定版本
//   pnpm check:release-anchor --phase post-merge --version X.Y.Z  # CD gate 用
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGhApiClient } from './lib/github-rest';

const ROOT = join(import.meta.dirname, '..');
const REPO = 'zlh12331/superagent';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** SemVer 严格白名单：通过后动态值才允许进入 URL path（字符面仅 [0-9a-zA-Z.-]，且
 *  固定前缀 "v" 由代码补——SemVer 白名单保证无 "/" "?" "#" "%" 等路径逃逸字符）。 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type AnchorPhase = 'pre-merge' | 'post-merge';

export interface AnchorCheckOptions {
  /** CLI 参数（默认 process.argv.slice(2)）：支持 --version X / --phase pre-merge|post-merge */
  argv?: string[];
  /** manifest 路径（测试注入用）；默认 <repoRoot>/.release-please-manifest.json */
  manifestPath?: string;
  /** Bearer token；缺省读 GITHUB_TOKEN 环境变量 */
  token?: string;
  /** fetch 注入点（测试用）；缺省全局 fetch */
  fetchFn?: typeof fetch;
}

function parseArgs(argv: string[]): { versionFlag: string | null; phase: AnchorPhase } {
  const versionFlagIdx = argv.indexOf('--version');
  const versionFlag =
    versionFlagIdx >= 0 && argv[versionFlagIdx + 1] ? (argv[versionFlagIdx + 1] as string) : null;
  const phaseIdx = argv.indexOf('--phase');
  const phaseRaw = phaseIdx >= 0 && argv[phaseIdx + 1] ? (argv[phaseIdx + 1] as string) : null;
  if (phaseRaw !== null && phaseRaw !== 'pre-merge' && phaseRaw !== 'post-merge') {
    throw new Error(`未知 --phase：${phaseRaw}（仅支持 pre-merge / post-merge）`);
  }
  return { versionFlag, phase: phaseRaw ?? 'pre-merge' };
}

function readManifestVersion(manifestPath: string): string | null {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
  return typeof manifest['.'] === 'string' ? manifest['.'] : null;
}

/**
 * 收集锚点检查结果（不决定退出码——由 CLI 入口汇总打印并 process.exit）。
 * 版本缺失/不合法时抛错（入口转 exit 1）；单项检查失败以 ok:false 表达，
 * 网络失败一律 ok:false（fail-closed），404 → null 的「不存在」是合法路径。
 */
export async function collectAnchorChecks(
  options: AnchorCheckOptions = {},
): Promise<CheckResult[]> {
  const argv = options.argv ?? process.argv.slice(2);
  const { versionFlag, phase } = parseArgs(argv);
  const manifestPath = options.manifestPath ?? join(ROOT, '.release-please-manifest.json');

  const manifestVersion = readManifestVersion(manifestPath);
  const version = versionFlag ?? manifestVersion;
  if (!version || !SEMVER_RE.test(version)) {
    throw new Error(`版本缺失或未通过 SemVer 白名单：${version ?? '(null)'}——拒绝发起任何请求`);
  }
  const tag = `v${version}`;
  console.log(`[check-release-anchor] 校验版本 ${version}（tag ${tag}，phase=${phase}）`);

  const token = options.token ?? process.env['GITHUB_TOKEN'];
  const client = createGhApiClient({
    repo: REPO,
    // exactOptionalPropertyTypes：可选字段传 undefined 需条件展开
    ...(token !== undefined ? { token } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });

  // ── 参照系说明 ──────────────────────────────────────────────────────
  // 「合并前」校验的版本基线 = 最近已收尾（tagged）Release PR 的版本（lastReleased），
  // 不是 manifest——manifest 在 PR 合并后才更新，合并前它还是上一个版本的值。
  // 待合并 PR 的版本必须严格大于 lastReleased；而「tag 存在性」校验只对
  // lastReleased 做（待发布版本的 tag 本来就不该存在，合并后由 CD 打）。
  let lastReleased: string | null = version; // 兜底：找不到 PR 时退回 manifest 值

  const results: CheckResult[] = [];

  // ── post-merge（CD gate，打 tag 前）────────────────────────────────
  // 只断言本阶段可判定的两件事；不套用 pre-merge 的 label 检查——刚合并的 PR
  // 此刻停在 autorelease: pending 属合法状态（收尾在 release job 末尾）。
  if (phase === 'post-merge') {
    results.push({
      name: `manifest 版本 = ${version}（发布提交内一致性）`,
      ok: manifestVersion === version,
      detail:
        manifestVersion === version
          ? '一致 ✓'
          : `manifest 为 ${manifestVersion ?? '(null)'}——与发布提交版本不一致，锚点断裂`,
    });

    let tagAbsent = false;
    let tagLookupFailed = false;
    try {
      const ref = (await client.getJson(`/repos/${REPO}/git/ref/tags/v${version}`)) as unknown;
      tagAbsent = ref === null;
    } catch {
      tagLookupFailed = true;
    }
    results.push({
      name: `tag ${tag} 尚不存在（待本次 CD 创建）`,
      ok: tagAbsent && !tagLookupFailed,
      detail: tagLookupFailed
        ? 'GitHub API 不可达：无法核验（fail-closed）——检查网络/GITHUB_TOKEN 后重跑'
        : tagAbsent
          ? '不存在 ✓'
          : `tag ${tag} 已存在——重跑挪位或重复发版事故形态，先按 RELEASING.md §5 处置再放行`,
    });
    return results;
  }

  // ── 检查 1：manifest 版本 ↔ tag 存在性（仅当 manifest ≠ lastReleased 才有意义，
  //    即"当前发布点"；首战实测：对"待发布版本"查 tag 会误报，已改为按 lastReleased）──
  // （此项并入检查 2 的 lastReleased 逻辑，见下）

  // ── 检查 2：最近已合并 release-please PR 的 label 与 tag 对应（版本基线来源）──
  {
    let pr: { number: number; title: string; labels: { name: string }[] } | null = null;
    let fetchFailed = false;
    try {
      const list = (await client.getJson(
        `/repos/${REPO}/pulls?state=closed&per_page=30&sort=updated&direction=desc`,
      )) as {
        number: number;
        title: string;
        head?: { ref?: string };
        merged_at?: string | null;
      }[];
      const head = (list ?? []).find(
        (p) => (p.head?.ref ?? '').startsWith('release-please--') && p.merged_at !== null,
      );
      if (head) {
        const detail = (await client.getJson(`/repos/${REPO}/pulls/${String(head.number)}`)) as {
          labels?: { name: string }[];
          title?: string;
        };
        pr = {
          number: head.number,
          title: detail.title ?? head.title,
          labels: detail.labels ?? [],
        };
      }
    } catch {
      // 网络失败 → fail-closed（2026-10-06 起不再静默落入「正常」分支）
      fetchFailed = true;
    }
    if (pr) {
      const labels = pr.labels.map((l) => l.name);
      const pending = labels.includes('autorelease: pending');
      const tagged = labels.includes('autorelease: tagged');
      const m = pr.title.match(/release (\S+)/);
      const prVersionRaw = m ? m[1] : null;
      const prVersion = prVersionRaw && SEMVER_RE.test(prVersionRaw) ? prVersionRaw : null;

      results.push({
        name: `最近 Release PR #${pr.number}（${pr.title}）label 收尾`,
        ok: !pending,
        detail: pending
          ? '停在 autorelease: pending——若 CD 已失败未出包，先修 CD 再决定补 tag 或改 label'
          : tagged
            ? 'tagged ✓'
            : `labels=[${labels.join(',')}]`,
      });

      // lastReleased = 最近已收尾（tagged）Release PR 的版本——合并前校验的基线
      if (prVersion && tagged) {
        lastReleased = prVersion;
      }

      if (prVersion && tagged) {
        let tagOk = false;
        try {
          const ref = (await client.getJson(`/repos/${REPO}/git/ref/tags/v${prVersion}`)) as {
            object?: { sha?: string };
          };
          tagOk = typeof ref?.object?.sha === 'string';
        } catch {
          tagOk = false;
        }
        results.push({
          name: `已收尾 Release PR 的版本 v${prVersion} 有 tag`,
          ok: tagOk,
          detail: tagOk
            ? 'tag 存在 ✓'
            : `PR #${pr.number} 标记 tagged 但 tag v${prVersion} 不存在——锚点断裂（本次事故形态），需补 tag 或回滚 manifest`,
        });
      }
    } else if (fetchFailed) {
      results.push({
        name: '最近 Release PR',
        ok: false,
        detail: 'GitHub API 不可达：无法核验（fail-closed）——检查网络/GITHUB_TOKEN 后重跑',
      });
    } else {
      results.push({
        name: '最近 Release PR',
        ok: true,
        detail: '近期无已合并的 release-please PR（正常）',
      });
    }
  }

  // ── 检查 3：当前 open 的 release-please PR 版本方向 ───────────────────
  {
    let open: { number: number; title: string } | null = null;
    let fetchFailed = false;
    try {
      const list = (await client.getJson(
        `/repos/${REPO}/pulls?state=open&per_page=20&sort=updated&direction=desc`,
      )) as { number: number; title: string; head?: { ref?: string } }[];
      const head = (list ?? []).find((p) => (p.head?.ref ?? '').startsWith('release-please--'));
      if (head) open = { number: head.number, title: head.title };
    } catch {
      // 网络失败 → fail-closed（2026-10-06 起不再静默落入「无（正常）」分支）
      fetchFailed = true;
    }
    if (open) {
      const m = open.title.match(/release (\S+)/);
      const openVersionRaw = m ? m[1] : null;
      const openVersion = openVersionRaw && SEMVER_RE.test(openVersionRaw) ? openVersionRaw : null;
      if (openVersion) {
        // 待合并 PR 的版本必须严格大于「最近已发布版本」（lastReleased，取自已收尾
        // Release PR；manifest 在合并前仍是上一版值，不能作参照——首战实测教训）
        const cmp = compareVersions(openVersion, lastReleased ?? '');
        results.push({
          name: `待合并 Release PR #${open.number}（${openVersion}）> 已发布版本（${lastReleased}）`,
          ok: cmp > 0,
          detail: cmp > 0 ? '推导方向正确 ✓' : '版本未前进——锚点可能错乱，勿合并',
        });
      } else {
        results.push({
          name: `待合并 Release PR #${open.number}`,
          ok: false,
          detail: `标题版本未通过 SemVer 白名单：${openVersionRaw ?? '(null)'}`,
        });
      }
    } else if (fetchFailed) {
      results.push({
        name: '待合并 Release PR',
        ok: false,
        detail: 'GitHub API 不可达：无法核验（fail-closed）——检查网络/GITHUB_TOKEN 后重跑',
      });
    } else {
      results.push({ name: '待合并 Release PR', ok: true, detail: '无（正常）' });
    }
  }

  return results;
}

/** SemVer 比较（含 prerelease；只服务本脚本的方向性判定） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-');
    const nums = (core ?? '').split('.').map(Number);
    return { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const paParts = pa.pre.split('.');
  const pbParts = pb.pre.split('.');
  for (let i = 0; i < Math.max(paParts.length, pbParts.length); i++) {
    const x = paParts[i];
    const y = pbParts[i];
    if (x === y) continue;
    // a 已耗尽而 b 还有段 → a 更小（beta < beta.1 的反面）；b 已耗尽 → a 更大。
    // SemVer：前缀相同时，预发布标识符更多者优先级更高（1.8.0-beta.1 > 1.8.0-beta）。
    // ⚠️ 方向曾写反（y 耗尽 return -1）：冻结基底首例（beta → beta.1）触发
    // 「版本未前进」误报——回归用例见 check-release-anchor.test.ts。
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number(x);
    const yn = Number(y);
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) return xn - yn;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function main(): Promise<void> {
  let results: CheckResult[];
  try {
    results = await collectAnchorChecks();
  } catch (error) {
    console.error(
      `[check-release-anchor] ❌ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}：${r.detail}`);
    if (!r.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`\n[check-release-anchor] ❌ ${failed} 项不自洽——禁止合并 Release PR。`);
    console.error('  修复路径（按事故形态选）：');
    console.error(
      '  a) tag 缺失但内容应发布：gh api -X POST repos/.../git/refs -f ref=refs/tags/<tag> -f sha=<release commit 全 SHA>',
    );
    console.error('  b) 内容不应发布（CD 失败且不重试）：revert release commit 使 manifest 回退');
    console.error('  c) label 停在 pending：确认无发版意图后手工改 tagged 并重跑 release-please');
    process.exit(1);
  }
  console.log(`[check-release-anchor] ✅ 锚点自洽（${results.length} 项检查通过）`);
}

// 仅直接执行时跑 CLI（import 进单测不触发网络/exit——check-commit-msg 无守卫的
// 教训：模块级 main() 依赖真实仓库状态，曾致 test:scripts 偶发红）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error('[check-release-anchor] ❌ 执行失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
