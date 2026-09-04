import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// capture/benchmark/report.ts
var round3 = (v) => Math.round(v * 1e3) / 1e3;
function summarize(input) {
  const cards = input.cards;
  const covered = cards.filter((c) => c.animationCount > 0 || c.segmentCount > 0);
  const coverage = cards.length ? covered.length / cards.length : 0;
  const sourceTotals = { css: 0, transition: 0, waapi: 0, sampled: 0 };
  const triggerTotals = {};
  let segErrSum = 0;
  let segErrN = 0;
  let sampledCards = 0;
  const byCat = /* @__PURE__ */ new Map();
  for (const c of cards) {
    sourceTotals.css += c.sources.css;
    sourceTotals.transition += c.sources.transition;
    sourceTotals.waapi += c.sources.waapi;
    sourceTotals.sampled += c.sources.sampled;
    if (c.sources.sampled > 0) sampledCards++;
    for (const [k, v] of Object.entries(c.triggers)) {
      triggerTotals[k] = (triggerTotals[k] ?? 0) + (v ?? 0);
    }
    if (c.avgSegmentError != null) {
      segErrSum += c.avgSegmentError;
      segErrN++;
    }
    const arr = byCat.get(c.category) ?? [];
    arr.push(c);
    byCat.set(c.category, arr);
  }
  const categories = [...byCat.entries()].map(([category, arr]) => {
    const cov = arr.filter((c) => c.animationCount > 0 || c.segmentCount > 0).length;
    return {
      category,
      route: arr[0]?.route ?? "",
      total: arr.length,
      covered: cov,
      coverage: arr.length ? round3(cov / arr.length) : 0,
      noAnimation: arr.filter((c) => c.status === "no-animation").length,
      errors: arr.filter((c) => c.status === "error" || c.status === "timeout").length
    };
  });
  const failures = cards.filter((c) => c.status !== "ok").map((c) => ({ id: c.id, category: c.category, status: c.status, reason: c.reason ?? "" }));
  return {
    meta: {
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      perCategory: input.perCategory,
      routes: input.routes
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
    cards
  };
}
function bar(v, width = 20) {
  const n = Math.round(v * width);
  return "\u2588".repeat(n) + "\u2591".repeat(Math.max(0, width - n));
}
function toMarkdown(s) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const lines = [];
  lines.push("# MotionLens Benchmark Report");
  lines.push("");
  lines.push("## \u6D4B\u8BD5\u7ED3\u679C\u6458\u8981\uFF08\u53EF\u76F4\u63A5\u8D34 README\uFF09");
  lines.push("");
  lines.push("```text");
  lines.push(
    `MotionLens \u5BF9 MotionVault \u7075\u611F\u5E93 ${s.total} \u4E2A\u52A8\u6548\u5361\u7247\u81EA\u52A8\u63D0\u53D6\uFF1A\u603B\u8986\u76D6\u7387 ${pct(s.coverage)}\uFF08${s.covered}/${s.total}\uFF09\u3002`
  );
  lines.push(
    `\u7ED3\u6784\u5316\u63D0\u53D6\uFF08WAAPI/CSS/Transition\uFF09\u52A8\u753B\u5171 ${s.sourceTotals.css + s.sourceTotals.transition + s.sourceTotals.waapi} \u6761\uFF1Acss=${s.sourceTotals.css}, transition=${s.sourceTotals.transition}, waapi=${s.sourceTotals.waapi}\uFF1B`
  );
  lines.push(
    `\u91C7\u6837\u56DE\u653E\u515C\u5E95\u547D\u4E2D ${s.sampledCards} \u5F20\u5361\uFF08segments \u5171 ${s.sourceTotals.sampled} \u6BB5\uFF0C\u5E73\u5747\u62DF\u5408\u6B8B\u5DEE ${s.avgSegmentError ?? "\u2014"}\uFF09\u3002`
  );
  lines.push("```");
  lines.push("");
  lines.push("## \u6307\u6807");
  lines.push("");
  lines.push(`- \u8FD0\u884C\u65F6\u95F4\uFF1A${new Date(s.meta.startedAt).toISOString()}\uFF0C\u8017\u65F6 ${(s.meta.durationMs / 1e3).toFixed(1)}s`);
  lines.push(`- \u91C7\u6837\u6A21\u5F0F\uFF1A\u6BCF\u5206\u7C7B ${s.meta.perCategory} \u5F20\u5361`);
  lines.push(`- **\u603B\u8986\u76D6\u7387\uFF1A${pct(s.coverage)}**\uFF08${s.covered}/${s.total}\uFF0C\u22651 \u6761\u7ED3\u6784\u5316\u52A8\u753B\u6216 sampled segments \u975E\u7A7A\uFF09`);
  lines.push(`- \u91C7\u6837\u62DF\u5408\u5E73\u5747 error\uFF1A${s.avgSegmentError ?? "\u2014"}`);
  lines.push("");
  lines.push("### \u5206\u6765\u6E90\u7EDF\u8BA1\uFF08\u52A8\u753B\u6761\u6570\uFF09");
  lines.push("");
  lines.push("| source | count |");
  lines.push("| --- | ---: |");
  lines.push(`| css | ${s.sourceTotals.css} |`);
  lines.push(`| transition | ${s.sourceTotals.transition} |`);
  lines.push(`| waapi | ${s.sourceTotals.waapi} |`);
  lines.push(`| sampled(segments) | ${s.sourceTotals.sampled} |`);
  lines.push("");
  lines.push("### trigger \u5206\u5E03\uFF08\u52A8\u753B\u6761\u6570\uFF09");
  lines.push("");
  lines.push("| trigger | count |");
  lines.push("| --- | ---: |");
  for (const [k, v] of Object.entries(s.triggerTotals).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("### \u5206\u5206\u7C7B\u8986\u76D6\u7387");
  lines.push("");
  lines.push("| category | route | cards | covered | coverage | no-animation | error |");
  lines.push("| --- | --- | ---: | ---: | --- | ---: | ---: |");
  for (const c of s.categories) {
    lines.push(
      `| ${c.category} | ${c.route} | ${c.total} | ${c.covered} | ${bar(c.coverage)} ${pct(c.coverage)} | ${c.noAnimation} | ${c.errors} |`
    );
  }
  lines.push("");
  lines.push(`### \u5931\u8D25\u6E05\u5355\uFF08${s.failures.length}\uFF09`);
  lines.push("");
  if (s.failures.length === 0) {
    lines.push("\u65E0\u3002");
  } else {
    lines.push("| card | category | status | reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of s.failures) {
      lines.push(`| ${f.id} | ${f.category} | ${f.status} | ${f.reason.replace(/\|/g, "\\|")} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function buildCardResult(partial) {
  const animations = partial.animations ?? [];
  const segments = partial.segments ?? [];
  const sources = { css: 0, transition: 0, waapi: 0, sampled: 0 };
  const triggers = {};
  for (const a of animations) {
    if (a.source === "css" || a.source === "transition" || a.source === "waapi") sources[a.source]++;
    triggers[a.trigger] = (triggers[a.trigger] ?? 0) + 1;
  }
  sources.sampled = segments.length;
  if (segments.length > 0) triggers.unknown = (triggers.unknown ?? 0) + 0;
  const avgSegmentError = segments.length ? round3(segments.reduce((s, g) => s + g.error, 0) / segments.length) : null;
  const { animations: _a, segments: _s, ...rest } = partial;
  return {
    ...rest,
    sources,
    animationCount: animations.length,
    segmentCount: segments.length,
    avgSegmentError,
    triggers
  };
}
export {
  buildCardResult,
  summarize,
  toMarkdown
};
