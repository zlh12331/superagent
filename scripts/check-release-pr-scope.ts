// scripts/check-release-pr-scope.ts
// Release PR 内容边界闸门（护栏 C，2026-10-06 落地）
// ──────────────────────────────────────────────────────────────
// 背景：#90 作为 Release PR 携带 276 行 check-release-anchor.ts 等代码进 main
//   ——ci.yml 的瘦身 if 只看分支名不看 diff，且恰逢 #93 空 squash，该代码从未
//   经任何 CI。「Release PR 只含版本号 + CHANGELOG」此前是口头不变量，本脚本
//   把它变成闸门。
//
// 职责：拉取 release-please 分支 PR 的 files 列表，断言每个 path ∈ 白名单：
//   CHANGELOG.md / .release-please-manifest.json / package.json
//   package.json 只允许动 "version": 行（release-please 的版本 bump）。
//   patch 字段缺失（GitHub 对超 ~400 行 diff 省略）时 package.json 按越界
//   fail-closed（内容约束无从执行，要求人工复核）；任一越界 → exit 1，
//   提示先走普通 PR 再发版。
//
// 接线：ci.yml quality 的「Release PR gates」步骤（ruleset 必需检查 ⇒ 自动获得
//   合并阻塞力）+ release.yml gate 兜底。
//
// 实现：复用 scripts/lib/github-rest.ts（零子进程 + SSRF 防线 + fetch 注入）。
//   PR 号来源：--pr N 显式指定，或按 head 分支名 release-please--* 从 open PR
//   中查找（CI 场景 github.head_ref 即该分支）。
//
// 用法：
//   pnpm check:release-pr-scope --pr 98
//   pnpm check:release-pr-scope --branch release-please--branches--main
// ──────────────────────────────────────────────────────────────

import { pathToFileURL } from 'node:url';

import { createGhApiClient } from './lib/github-rest';

const REPO = 'zlh12331/superagent';

/** Release PR 允许出现的文件（release-please 的全部产出）。越界 = 有代码想搭车。 */
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  'CHANGELOG.md',
  '.release-please-manifest.json',
  'package.json',
]);

/** package.json 的 diff 只允许版本 bump 行（release-please 的全部改动面） */
const VERSION_LINE_RE = /^\+{1,2}\s*"version":/;

export interface ScopeCheckOptions {
  /** CLI 参数（默认 process.argv.slice(2)）：--pr N 或 --branch <headRefName> */
  argv?: string[];
  token?: string;
  fetchFn?: typeof fetch;
  /** PR 文件列表注入（测试用）：与 GitHub GET /pulls/{n}/files 同构 */
  filesOverride?: { filename: string; patch?: string }[];
}

export interface ScopeViolation {
  filename: string;
  reason: string;
}

/** 纯函数：判定文件列表是否越界（单测直测，不发请求）
 *
 * ⚠️ package.json 的 patch 缺失时 fail-closed（2026-10-07 收口）：GitHub API 对
 * 超 ~400 行 diff 的文件**省略 patch 字段**——此时「仅允许版本行」约束无从执行，
 * 按存在性风险处理（报 violation 要求人工复核），不静默放行。静默放行的后果：
 * package.json 大改（如注入恶意 script）可借超大 diff 搭车。CHANGELOG.md /
 * .release-please-manifest.json 的 patch 缺失不拦：两者均在白名单内且非可执行
 * 内容，release-please 的产出恒为追加段落/单行版本号。
 */
export function findScopeViolations(
  files: { filename: string; patch?: string }[],
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const f of files) {
    if (!ALLOWED_PATHS.has(f.filename)) {
      violations.push({
        filename: f.filename,
        reason:
          '不在 Release PR 白名单（允许：CHANGELOG.md / .release-please-manifest.json / package.json）',
      });
      continue;
    }
    if (f.filename === 'package.json') {
      // patch 缺失（GitHub 对超大 diff 省略该字段）→ 内容约束失效，fail-closed
      if (f.patch === undefined) {
        violations.push({
          filename: f.filename,
          reason:
            'package.json 的 diff 内容不可得（GitHub 对超 ~400 行 diff 省略 patch 字段）——' +
            '"仅允许版本行"约束无法执行，请人工在 PR 页面复核该文件的完整 diff',
        });
        continue;
      }
      const badLines = f.patch
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .filter((line) => !VERSION_LINE_RE.test(line));
      if (badLines.length > 0) {
        violations.push({
          filename: f.filename,
          reason: `package.json 仅允许版本 bump 行，越界新增：${badLines.join(' ; ')}`,
        });
      }
    }
  }
  return violations;
}

function parseArgs(argv: string[]): { pr: number | null; branch: string | null } {
  const prIdx = argv.indexOf('--pr');
  const pr = prIdx >= 0 && argv[prIdx + 1] ? Number(argv[prIdx + 1]) : null;
  const branchIdx = argv.indexOf('--branch');
  const branch = branchIdx >= 0 && argv[branchIdx + 1] ? (argv[branchIdx + 1] as string) : null;
  if (pr === null && branch === null) {
    throw new Error('必须提供 --pr <PR号> 或 --branch <head 分支名>（CI 传 github.head_ref）');
  }
  return { pr: pr !== null && Number.isInteger(pr) && pr > 0 ? pr : null, branch };
}

/**
 * 拉取目标 Release PR 的文件列表（fetch 注入可测）。
 * --pr 直接取；--branch 按 head.ref 在 open PR 中查找。
 */
export async function fetchReleasePrFiles(
  options: ScopeCheckOptions = {},
): Promise<{ number: number; files: { filename: string; patch?: string }[] }> {
  const argv = options.argv ?? process.argv.slice(2);
  const { pr, branch } = parseArgs(argv);
  const client = createGhApiClient({
    repo: REPO,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });

  if (pr !== null) {
    const files = (await client.getJson(`/repos/${REPO}/pulls/${String(pr)}/files?per_page=100`)) as
      | { filename: string; patch?: string }[]
      | null;
    if (files === null) {
      throw new Error(`PR #${String(pr)} 不存在（404）`);
    }
    return { number: pr, files };
  }

  const list = (await client.getJson(
    `/repos/${REPO}/pulls?state=open&per_page=20&sort=updated&direction=desc`,
  )) as { number: number; head?: { ref?: string } }[] | null;
  const head = (list ?? []).find((p) => (p.head?.ref ?? '') === branch);
  if (!head) {
    throw new Error(`未找到 head 分支为 ${branch ?? '(null)'} 的 open PR`);
  }
  const files = (await client.getJson(
    `/repos/${REPO}/pulls/${String(head.number)}/files?per_page=100`,
  )) as { filename: string; patch?: string }[] | null;
  return { number: head.number, files: files ?? [] };
}

export async function runScopeCheck(options: ScopeCheckOptions = {}): Promise<void> {
  const files = options.filesOverride;
  let prNumber: number;
  let actualFiles: { filename: string; patch?: string }[];
  if (files !== undefined) {
    prNumber = -1; // 注入模式（测试/演练）
    actualFiles = files;
  } else {
    const fetched = await fetchReleasePrFiles(options);
    prNumber = fetched.number;
    actualFiles = fetched.files;
  }

  console.log(
    `[check-release-pr-scope] 校验 Release PR #${String(prNumber)}（${String(actualFiles.length)} 个文件）`,
  );
  const violations = findScopeViolations(actualFiles);
  if (violations.length > 0) {
    console.error('[check-release-pr-scope] ❌ Release PR 携带白名单外内容——禁止合并：');
    for (const v of violations) {
      console.error(`   ✗ ${v.filename}：${v.reason}`);
    }
    console.error('  处置：越界内容先走普通 PR（全量 CI 把关），Release PR 只等版本号+CHANGELOG。');
    process.exit(1);
  }
  console.log('[check-release-pr-scope] ✅ 内容边界干净（仅版本号 + CHANGELOG）');
}

// 仅直接执行时跑 CLI（main-module 守卫，import 不触发网络/exit）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScopeCheck().catch((e: unknown) => {
    console.error('[check-release-pr-scope] ❌ 执行失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
