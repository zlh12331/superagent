// changelog-draft.ts：CHANGELOG 润色底稿生成——把「最近发布 tag..HEAD」内的提交按可见类型（feat / fix / perf）
// 与其余类型分组，连同 squash 正文的 bullet 明细打印到标准输出。
// 为什么需要：release-please 只把 commit 标题写进 CHANGELOG、不解析 squash 正文的改动明细（RELEASING.md §2.1），
// 底稿把润色从「从零写」降级为「改」；输出仍是开发视角的事实清单、并非成品文案。
// 边界：只读 git、不改动任何文件；入口 pnpm release:draft。

import { execFileSync } from 'node:child_process';

// ───── 口径常量：底稿纳入哪些提交、明细展开多深、读 git 前的输入校验 ─────

/** 进 CHANGELOG 的类型（与 release-please-config.json 的 changelog-sections 对齐） */
const VISIBLE_TYPES = new Set(['feat', 'fix', 'perf']);

/** 每条提交最多展开的明细行数（防止超大 squash 刷屏） */
const MAX_DETAILS = 8;

/** release-please 的发布提交（不进入底稿，其内容由 Release PR 承载） */
const RELEASE_COMMIT = /^chore\((main|beta)\):\s+release\s/;

/** 合法 tag 形态（用于校验 git describe 输出，避免意外值流入 git 参数） */
const SAFE_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ───── 采集与解析：定位版本区间 → 读 git log → 解析为 DraftCommit ─────

interface DraftCommit {
  readonly hash: string;
  readonly subject: string;
  /** 已小写化的 Conventional 类型；不匹配 `type(scope): …` 形态时为 'other'（只影响分组，不丢提交） */
  readonly type: string;
  /** 正文中的 bullet 明细（每行去掉列表符号，最多 MAX_DETAILS 条） */
  readonly details: readonly string[];
}

/** 取最近一次发布 tag 作为区间起点；无 tag 时回落首个提交 */
function resolveBaseTag(): string {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      encoding: 'utf-8',
    }).trim();
    if (SAFE_TAG.test(tag)) {
      return tag;
    }
  } catch {}
  // describe 失败（浅克隆/新仓库无 tag）或输出不合 SAFE_TAG：回落到首个提交，让区间覆盖全部历史
  return execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf-8' })
    .trim()
    .split('\n')[0] as string;
}

/** 读取区间内提交（用分隔符拆字段，避免解析歧义） */
function readCommits(base: string): DraftCommit[] {
  // 正文可含换行与任意标点，字段/记录只有用 0x1f / 0x1e 控制字符（%x1f / %x1e）定界才切得开
  const raw = execFileSync(
    'git',
    ['log', `${base}..HEAD`, '--format=%h%x1f%s%x1f%b%x1e', '--no-merges'],
    { encoding: 'utf-8' },
  );
  return raw
    .split('\u001e')
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map(parseCommit)
    .filter((commit): commit is DraftCommit => commit !== null);
}

/** 单条提交解析：提取 hash / subject / type / body 明细 */
function parseCommit(record: string): DraftCommit | null {
  const [hash = '', subject = '', body = ''] = record.split('\u001f');
  if (RELEASE_COMMIT.test(subject)) {
    return null;
  }
  const matched = subject.match(/^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.*)$/);
  const type = matched?.[1]?.toLowerCase() ?? 'other';
  // 只取 bullet 行：正文的段落是背景说明，能逐条改写进 CHANGELOG 的只有列表项
  const details = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .slice(0, MAX_DETAILS);
  return { hash, subject, type, details };
}

// ───── 渲染：分成「可见改动 / 其余改动」两栏打印底稿 ─────

/** 按类型分组输出 */
function renderGroup(title: string, commits: readonly DraftCommit[]): string {
  // 空分组返回空串（main 会滤掉），避免打印出只有标题的空段
  if (commits.length === 0) {
    return '';
  }
  const lines = [`## ${title}`, ''];
  for (const commit of commits) {
    lines.push(`- ${commit.subject}`);
    for (const detail of commit.details) {
      lines.push(`  - ${detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const base = resolveBaseTag();
  const commits = readCommits(base);
  if (commits.length === 0) {
    console.log(`[changelog-draft] 区间 ${base}..HEAD 内无可纳入 CHANGELOG 的提交。`);
    return;
  }

  const visible = commits.filter((commit) => VISIBLE_TYPES.has(commit.type));
  const hidden = commits.filter((commit) => !VISIBLE_TYPES.has(commit.type));

  const parts = [
    '# CHANGELOG 润色底稿',
    '',
    `> 版本区间：\`${base}..HEAD\`（共 ${commits.length} 个提交，其中可见类型 ${visible.length} 个）`,
    '> 用法：把下面的可见改动改写成**面向用户**的文案，替换 CHANGELOG 里对应版本段；',
    '> 完成后跑 `pnpm check:changelog-polish` 验证。本节仅供改写参考，勿直接提交。',
    '',
    '---',
    '',
    renderGroup('可见改动（feat / fix / perf —— 会进 CHANGELOG，逐条判断用户能否感知）', visible),
    '---',
    '',
    renderGroup(
      '其余改动（refactor / test / chore … —— 默认不进 CHANGELOG，供理解上下文）',
      hidden,
    ),
  ];
  console.log(parts.filter((part) => part !== '').join('\n'));
}

main();
