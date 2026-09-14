// scripts/check-memory-engine-update.mjs
// 检查上游记忆引擎是否有新版本
// ──────────────────────────────────────────────────────────────
// 数据源：GitHub API 的 tags 列表（只读，无需认证；未认证时 60 次/小时限额足够）。
// 本脚本**只读**，不改任何文件。
//
// ⚠️ 网络说明：部分环境无法访问 GitHub（本项目实测 codeload 不可达）。
//   此时脚本以退出码 0 优雅提示"无法检查"，不视为失败——同步流程本身
//   依赖人工下载归档，不依赖本检查。
//
// 用法：node scripts/check-memory-engine-update.mjs
// ──────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VERSIONS_PATH = join(ROOT, 'packages', 'memory-engine', 'versions.json');

const versions = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
const { repository, repoTag } = versions;

// 从仓库 URL 提取 owner/repo
const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repository);
if (m === null) {
  console.error(`[memory-engine:check] ❌ 无法从 versions.json 解析仓库地址：${repository}`);
  process.exit(1);
}
const [, owner, repo] = m;

const apiUrl = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=20`;

console.log(`[memory-engine:check] 当前版本：${repoTag}`);
console.log(`[memory-engine:check] 查询上游：${owner}/${repo} …`);

let tags;
try {
  const res = await fetch(apiUrl, {
    // biome-ignore lint/style/useNamingConvention: HTTP 标准头名（PascalCase）
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'code-agent-desktop' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  tags = await res.json();
} catch (err) {
  // 网络不可用不算失败：同步流程不依赖本检查
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[memory-engine:check] ⚠ 无法访问上游（${reason}）`);
  console.warn('  本检查仅用于提示新版本；请手动下载上游归档后运行 memory-engine:sync。');
  process.exit(0);
}

if (!Array.isArray(tags) || tags.length === 0) {
  console.log('[memory-engine:check] 上游未返回任何 tag');
  process.exit(0);
}

const names = tags.map((t) => t.name);
const currentIdx = names.indexOf(repoTag);

console.log(`\n上游最近 ${names.length} 个 tag：`);
for (const [i, name] of names.entries()) {
  const mark = name === repoTag ? ' ← 当前' : i < currentIdx || currentIdx === -1 ? '' : '';
  console.log(`  ${name}${mark}`);
}

if (currentIdx === 0) {
  console.log('\n[memory-engine:check] ✅ 已是最新版本');
} else if (currentIdx === -1) {
  console.log(
    `\n[memory-engine:check] ⚠ 当前 tag ${repoTag} 不在最近列表中（可能是旧版本或本地 tag）`,
  );
} else {
  const newer = names.slice(0, currentIdx);
  console.log(`\n[memory-engine:check] 📦 有 ${newer.length} 个更新的版本：${newer.join(', ')}`);
  console.log(`  同步：node scripts/sync-memory-engine.mjs --from <解压目录> --tag ${newer[0]}`);
}
