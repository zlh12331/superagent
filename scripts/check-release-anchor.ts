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
    ...(token !== undefined ? { token } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });

  let lastReleased: string | null = version;

  const results: CheckResult[] = [];

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
      fetchFailed = true;
    }
    if (open) {
      const m = open.title.match(/release (\S+)/);
      const openVersionRaw = m ? m[1] : null;
      const openVersion = openVersionRaw && SEMVER_RE.test(openVersionRaw) ? openVersionRaw : null;
      if (openVersion) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error('[check-release-anchor] ❌ 执行失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
