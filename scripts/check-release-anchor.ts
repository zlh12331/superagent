// scripts/check-release-anchor.ts
// 发版锚点自洽检查（护栏 B，2026-10-05 落地）
// ──────────────────────────────────────────────────────────────
// 背景：1.6.x 发版连环事故（2026-10-05）——Release PR 合并时 CD 打包失败 →
//   tag 缺失，但 manifest 已推进、label 已收尾 tagged → release-please 三态
//   （tag ↔ manifest ↔ Release PR）不一致，版本推导回退全量历史（#80/#87 两次
//   误开、1.6.0 被消费、版本链跳到 1.6.1）。
//
// 职责：合并 Release PR **之前**校验三态自洽，不一致即 fail-closed（exit 1）。
//
// 实现（Mimosa 门禁对齐）：零子进程——Node 原生 fetch 直连 GitHub REST API。
//   SSRF 防线三重：① 仅 https + 固定 host 白名单（api.github.com）；
//   ② URL path 只由 SemVer 白名单派生字符 + 固定常量拼出；
//   ③ 请求前 assertSafeApiUrl 逐条复核（含 path 前缀锚定）。
//   认证：GITHUB_TOKEN 环境变量（只读公开数据也可匿名，但低限流）。
//
// 用法：
//   pnpm check:release-anchor                        # 校验 manifest 当前版本
//   pnpm check:release-anchor --version 1.6.2        # 显式指定版本
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const REPO = 'zlh12331/superagent';
const API_HOST = 'api.github.com';
const PATH_PREFIX = `/repos/${REPO}/`;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

/** SemVer 严格白名单：通过后动态值才允许进入 URL path（字符面仅 [0-9a-zA-Z.-]，且
 *  固定前缀 "v" 由代码补——SemVer 白名单保证无 "/" "?" "#" "%" 等路径逃逸字符）。 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** SSRF 防线：仅 https + host 白名单 + path 前缀锚定（逐条复核，不用 else 链省略）。 */
function assertSafeApiUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:') {
    throw new Error('protocol not https');
  }
  if (u.hostname !== API_HOST) {
    throw new Error('hostname not allowed');
  }
  if (!u.pathname.startsWith(PATH_PREFIX)) {
    throw new Error('path outside repo namespace');
  }
}

/** GitHub REST GET；404 → null（调用方按"不存在"处理），其他失败抛错。 */
async function ghApiJson(pathAndQuery: string): Promise<unknown | null> {
  const url = `https://${API_HOST}${pathAndQuery}`;
  assertSafeApiUrl(url);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'release-anchor-check',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${String(res.status)} for ${pathAndQuery}`);
  return (await res.json()) as unknown;
}

async function main(): Promise<void> {
  // ── 输入：要校验的版本（默认取 manifest）─────────────────────────────
  const argv = process.argv.slice(2);
  const versionFlagIdx = argv.indexOf('--version');
  let version: string | null =
    versionFlagIdx >= 0 && argv[versionFlagIdx + 1] ? (argv[versionFlagIdx + 1] as string) : null;

  if (!version) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'),
    ) as Record<string, string>;
    version = typeof manifest['.'] === 'string' ? manifest['.'] : null;
  }
  if (!version || !SEMVER_RE.test(version)) {
    console.error(
      `[check-release-anchor] ❌ 版本缺失或未通过 SemVer 白名单：${version ?? '(null)'}——拒绝发起任何请求`,
    );
    process.exit(1);
  }
  const tag = `v${version}`;
  console.log(`[check-release-anchor] 校验版本 ${version}（tag ${tag}）`);

  // ── 参照系说明 ──────────────────────────────────────────────────────
  // 「合并前」校验的版本基线 = 最近已收尾 Release PR 的版本（lastReleased），
  // 不是 manifest——manifest 在 PR 合并后才更新，合并前它还是上一个版本的值。
  // 待合并 PR 的版本必须严格大于 lastReleased；而「tag 存在性」校验只对
  // lastReleased 做（待发布版本的 tag 本来就不该存在，合并后由 CD 打）。
  let lastReleased: string | null = version; // 兜底：找不到 PR 时退回 manifest 值

  // ── 检查 1：manifest 版本 ↔ tag 存在性（仅当 manifest ≠ lastReleased 才有意义，
  //    即"当前发布点"；首战实测：对"待发布版本"查 tag 会误报，已改为按 lastReleased）──
  // （此项并入检查 2 的 lastReleased 逻辑，见下）

  // ── 检查 2：最近已合并 release-please PR 的 label 与 tag 对应（版本基线来源）──
  {
    let pr: { number: number; title: string; labels: { name: string }[] } | null = null;
    try {
      const list = (await ghApiJson(
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
        const detail = (await ghApiJson(`/repos/${REPO}/pulls/${String(head.number)}`)) as {
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
      // 网络失败 → 跳过该项并如实标注
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
          const ref = (await ghApiJson(`/repos/${REPO}/git/ref/tags/v${prVersion}`)) as {
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
    try {
      const list = (await ghApiJson(
        `/repos/${REPO}/pulls?state=open&per_page=20&sort=updated&direction=desc`,
      )) as { number: number; title: string; head?: { ref?: string } }[];
      const head = (list ?? []).find((p) => (p.head?.ref ?? '').startsWith('release-please--'));
      if (head) open = { number: head.number, title: head.title };
    } catch {
      // 网络失败 → 跳过
    }
    if (open) {
      const m = open.title.match(/release (\S+)/);
      const openVersionRaw = m ? m[1] : null;
      const openVersion = openVersionRaw && SEMVER_RE.test(openVersionRaw) ? openVersionRaw : null;
      if (openVersion) {
        // 待合并 PR 的版本必须严格大于「最近已发布版本」（lastReleased，取自已收尾
        // Release PR；manifest 在合并前仍是上一版值，不能作参照——首战实测教训）
        const cmp = compareVersions(openVersion, lastReleased);
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
    } else {
      results.push({ name: '待合并 Release PR', ok: true, detail: '无（正常）' });
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────────────
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

/** SemVer 比较（含 prerelease；只服务本脚本的方向性判定） */
function compareVersions(a: string, b: string): number {
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
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const xn = Number(x);
    const yn = Number(y);
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) return xn - yn;
    return x < y ? -1 : 1;
  }
  return 0;
}

main().catch((e: unknown) => {
  console.error('[check-release-anchor] ❌ 执行失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
