/**
 * report.ts — benchmark 结果统计与报告生成（纯函数 + 文件写入，node 侧运行）。
 * 产物：capture/benchmark/results/report.json + report.md
 */
import type { CapturedAnimation, FittedSegment, TriggerKind } from '../src/core/types';

export type CardStatus = 'ok' | 'no-animation' | 'timeout' | 'error';

export interface CardResult {
  category: string;
  route: string;
  index: number;
  /** 稳定 id：category/index/标题 slug */
  id: string;
  title: string;
  status: CardStatus;
  reason?: string;
  /** 结构化动画按来源计数 */
  sources: { css: number; transition: number; waapi: number; sampled: number };
  animationCount: number;
  segmentCount: number;
  avgSegmentError: number | null;
  triggers: Partial<Record<TriggerKind, number>>;
  /** 该卡片提取耗时 ms */
  tookMs: number;
}

export interface BenchInput {
  startedAt: string;
  durationMs: number;
  routes: string[];
  perCategory: number | 'all';
  cards: CardResult[];
}

export interface CategoryRow {
  category: string;
  route: string;
  total: number;
  covered: number;
  coverage: number;
  noAnimation: number;
  errors: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function summarize(input: BenchInput) {
  const cards = input.cards;
  const covered = cards.filter((c) => c.animationCount > 0 || c.segmentCount > 0);
  const coverage = cards.length ? covered.length / cards.length : 0;

  const sourceTotals = { css: 0, transition: 0, waapi: 0, sampled: 0 };
  const triggerTotals: Partial<Record<TriggerKind, number>> = {};
  let segErrSum = 0;
  let segErrN = 0;
  let sampledCards = 0;

  const byCat = new Map<string, CardResult[]>();
  for (const c of cards) {
    sourceTotals.css += c.sources.css;
    sourceTotals.transition += c.sources.transition;
    sourceTotals.waapi += c.sources.waapi;
    sourceTotals.sampled += c.sources.sampled;
    if (c.sources.sampled > 0) sampledCards++;
    for (const [k, v] of Object.entries(c.triggers)) {
      triggerTotals[k as TriggerKind] = (triggerTotals[k as TriggerKind] ?? 0) + (v ?? 0);
    }
    if (c.avgSegmentError != null) {
      segErrSum += c.avgSegmentError;
      segErrN++;
    }
    const arr = byCat.get(c.category) ?? [];
    arr.push(c);
    byCat.set(c.category, arr);
  }

  const categories: CategoryRow[] = [...byCat.entries()].map(([category, arr]) => {
    const cov = arr.filter((c) => c.animationCount > 0 || c.segmentCount > 0).length;
    return {
      category,
      route: arr[0]?.route ?? '',
      total: arr.length,
      covered: cov,
      coverage: arr.length ? round3(cov / arr.length) : 0,
      noAnimation: arr.filter((c) => c.status === 'no-animation').length,
      errors: arr.filter((c) => c.status === 'error' || c.status === 'timeout').length,
    };
  });

  const failures = cards
    .filter((c) => c.status !== 'ok')
    .map((c) => ({ id: c.id, category: c.category, status: c.status, reason: c.reason ?? '' }));

  return {
    meta: {
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      perCategory: input.perCategory,
      routes: input.routes,
    },
    total: cards.length,
    covered: covered.length,
    coverage: round3(coverage),
    sourceTotals,
    sampledCards,
    triggerTotals,
    avgSegmentError: segErrN ? round3(segErrSum / segErrN) : null,
    categories,
    failures,
    cards,
  };
}

type Summary = ReturnType<typeof summarize>;

function bar(v: number, width = 20): string {
  const n = Math.round(v * width);
  return '█'.repeat(n) + '░'.repeat(Math.max(0, width - n));
}

export function toMarkdown(s: Summary): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('# MotionLens Benchmark Report');
  lines.push('');
  lines.push('## 测试结果摘要（可直接贴 README）');
  lines.push('');
  lines.push('```text');
  lines.push(
    `MotionLens 对 MotionVault 灵感库 ${s.total} 个动效卡片自动提取：` +
      `总覆盖率 ${pct(s.coverage)}（${s.covered}/${s.total}）。`,
  );
  lines.push(
    `结构化提取（WAAPI/CSS/Transition）动画共 ${
      s.sourceTotals.css + s.sourceTotals.transition + s.sourceTotals.waapi
    } 条：css=${s.sourceTotals.css}, transition=${s.sourceTotals.transition}, waapi=${s.sourceTotals.waapi}；`,
  );
  lines.push(
    `采样回放兜底命中 ${s.sampledCards} 张卡（segments 共 ${s.sourceTotals.sampled} 段，` +
      `平均拟合残差 ${s.avgSegmentError ?? '—'}）。`,
  );
  lines.push('```');
  lines.push('');
  lines.push('## 指标');
  lines.push('');
  lines.push(`- 运行时间：${new Date(s.meta.startedAt).toISOString()}，耗时 ${(s.meta.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- 采样模式：每分类 ${s.meta.perCategory} 张卡`);
  lines.push(`- **总覆盖率：${pct(s.coverage)}**（${s.covered}/${s.total}，≥1 条结构化动画或 sampled segments 非空）`);
  lines.push(`- 采样拟合平均 error：${s.avgSegmentError ?? '—'}`);
  lines.push('');
  lines.push('### 分来源统计（动画条数）');
  lines.push('');
  lines.push('| source | count |');
  lines.push('| --- | ---: |');
  lines.push(`| css | ${s.sourceTotals.css} |`);
  lines.push(`| transition | ${s.sourceTotals.transition} |`);
  lines.push(`| waapi | ${s.sourceTotals.waapi} |`);
  lines.push(`| sampled(segments) | ${s.sourceTotals.sampled} |`);
  lines.push('');
  lines.push('### trigger 分布（动画条数）');
  lines.push('');
  lines.push('| trigger | count |');
  lines.push('| --- | ---: |');
  for (const [k, v] of Object.entries(s.triggerTotals).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push('### 分分类覆盖率');
  lines.push('');
  lines.push('| category | route | cards | covered | coverage | no-animation | error |');
  lines.push('| --- | --- | ---: | ---: | --- | ---: | ---: |');
  for (const c of s.categories) {
    lines.push(
      `| ${c.category} | ${c.route} | ${c.total} | ${c.covered} | ${bar(c.coverage)} ${pct(c.coverage)} | ${c.noAnimation} | ${c.errors} |`,
    );
  }
  lines.push('');
  lines.push(`### 失败清单（${s.failures.length}）`);
  lines.push('');
  if (s.failures.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| card | category | status | reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of s.failures) {
      lines.push(`| ${f.id} | ${f.category} | ${f.status} | ${f.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function buildCardResult(partial: Omit<CardResult, 'sources' | 'animationCount' | 'segmentCount' | 'avgSegmentError' | 'triggers'> & {
  animations?: CapturedAnimation[];
  segments?: FittedSegment[];
}): CardResult {
  const animations = partial.animations ?? [];
  const segments = partial.segments ?? [];
  const sources = { css: 0, transition: 0, waapi: 0, sampled: 0 };
  const triggers: Partial<Record<TriggerKind, number>> = {};
  for (const a of animations) {
    if (a.source === 'css' || a.source === 'transition' || a.source === 'waapi') sources[a.source]++;
    triggers[a.trigger] = (triggers[a.trigger] ?? 0) + 1;
  }
  sources.sampled = segments.length;
  if (segments.length > 0) triggers.unknown = (triggers.unknown ?? 0) + 0; // sampled 无 trigger 归属
  const avgSegmentError = segments.length
    ? round3(segments.reduce((s, g) => s + g.error, 0) / segments.length)
    : null;
  const { animations: _a, segments: _s, ...rest } = partial;
  return {
    ...rest,
    sources,
    animationCount: animations.length,
    segmentCount: segments.length,
    avgSegmentError,
    triggers,
  };
}
