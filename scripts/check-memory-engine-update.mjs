import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VERSIONS_PATH = join(ROOT, 'packages', 'memory-engine', 'versions.json');

const versions = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
const { repository, repoTag } = versions;

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
