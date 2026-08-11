// scripts/extract-tokens.cjs
// 一次性迁移工具：globals.css → tokens/aurora.json（Style Dictionary 单一真源）
// ──────────────────────────────────────────────────────────────
// 用法：node scripts/extract-tokens.cjs
// 说明：迁移完成后不再需要（改令牌直接改 tokens/aurora.json 后 pnpm tokens:build）
// 支持：多 :root/.dark 块、跨行值（字体栈等）、行内/块注释、var() 引用保留
// ──────────────────────────────────────────────────────────────

const fs = require('node:fs');

const css = fs.readFileSync('src/renderer/styles/globals.css', 'utf8');
const lines = css.split('\n');

function cleanComment(s) {
  return s
    .replace(/^\/\*+/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
}

function parseBlock(lines, startIdx) {
  const tokens = [];
  let i = startIdx;
  let pc = null; // pending comment
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith('}')) break;
    if (t.startsWith('/*')) {
      pc = cleanComment(t);
      i++;
      continue;
    }
    const m = t.match(/^--([a-zA-Z0-9-]+):\s*(.*)$/);
    if (m) {
      let value = m[2].trim();
      // 跨行值：未以 ; 结尾则拼接后续行
      while (!value.endsWith(';') && i + 1 < lines.length) {
        i++;
        value += ' ' + lines[i].trim();
      }
      value = value.replace(/;\s*$/, '').trim();
      // 行内注释剥离
      const cm = value.match(/^(.*?)\s*\/\*.*\*\//);
      if (cm) value = cm[1].trim();
      tokens.push({ name: m[1], value, comment: pc });
      pc = null;
    }
    i++;
  }
  return { tokens, endIdx: i };
}

const rootTokens = [];
const darkTokens = [];
let i = 0;
while (i < lines.length) {
  const t = lines[i].trim();
  if (t.startsWith(':root') && t.includes('{')) {
    const r = parseBlock(lines, i + 1);
    rootTokens.push(...r.tokens);
    i = r.endIdx + 1;
  } else if (t.startsWith('.dark') && t.includes('{')) {
    const d = parseBlock(lines, i + 1);
    darkTokens.push(...d.tokens);
    i = d.endIdx + 1;
  } else {
    i++;
  }
}

const out = {};
const rbn = new Map(rootTokens.map((t) => [t.name, t]));
for (const t of rootTokens) {
  const e = { value: t.value };
  if (t.comment) e.comment = t.comment;
  const d = darkTokens.find((dt) => dt.name === t.name);
  if (d && d.value !== t.value) e.dark = d.value;
  out[t.name] = e;
}
for (const d of darkTokens) {
  if (!rbn.has(d.name)) out[d.name] = { value: d.value, dark: d.value };
}

fs.writeFileSync('tokens/aurora.json', JSON.stringify(out, null, 2));
const cssNames = new Set([...rootTokens, ...darkTokens].map((t) => t.name));
const jsonNames = new Set(Object.keys(out));
const missing = [...cssNames].filter((n) => !jsonNames.has(n));
const extra = [...jsonNames].filter((n) => !cssNames.has(n));
console.log(
  `[extract-tokens] ${jsonNames.size} 令牌（root ${rootTokens.length} + dark ${darkTokens.length}）missing=${missing.length} extra=${extra.length}`,
);
if (missing.length > 0) console.log(`missing: ${missing.join(', ')}`);
