// scripts/build-tokens.mjs
// Aurora 令牌构建（Style Dictionary 5）：tokens/aurora.json → src/renderer/styles/tokens.css
// ──────────────────────────────────────────────────────────────
// 依据 docs/design/DESIGN.md（令牌契约单一真源：tokens/aurora.json）
// 输出：:root（value）+ .dark（dark 扩展字段，仅差异令牌）
// 用法：
//   pnpm tokens:build    # 生成 tokens.css
//   pnpm tokens:check    # 生成后校验无 diff（CI 用）
// ──────────────────────────────────────────────────────────────

import fs from 'node:fs';
import StyleDictionary from 'style-dictionary';

// SD 5 要求 source/buildPath 相对 cwd（绝对路径不解析）
const SOURCE = 'tokens/aurora.json';
const OUTPUT_REL = 'src/renderer/styles/tokens.css';
// 自定义 format：:root 段（value）+ .dark 段（dark 扩展，仅差异）
StyleDictionary.registerFormat({
  name: 'aurora/css',
  format: ({ dictionary }) => {
    const rootLines = [];
    const darkLines = [];
    for (const token of dictionary.allTokens) {
      const name = `--${token.name}`;
      const comment = token.comment !== undefined ? `  /* ${token.comment} */\n` : '';
      rootLines.push(`${comment}  ${name}: ${token.value};`);
      if (token.dark !== undefined && token.dark !== token.value) {
        darkLines.push(`${comment}  ${name}: ${token.dark};`);
      }
    }
    const parts = [
      '/* ⚠️ 生成文件（Style Dictionary）——请勿手改；修改 tokens/aurora.json 后运行 pnpm tokens:build */',
      ':root {',
      rootLines.join('\n'),
      '}',
    ];
    if (darkLines.length > 0) {
      parts.push('', '.dark {', darkLines.join('\n'), '}');
    }
    return parts.join('\n');
  },
});

const config = {
  source: [SOURCE],
  platforms: {
    css: {
      transformGroup: 'css',
      buildPath: 'src/renderer/styles/',
      files: [{ destination: 'tokens.css', format: 'aurora/css' }],
    },
  },
};

const sd = new StyleDictionary(config);
await sd.buildAllPlatforms();
console.log(
  `[build-tokens] ✅ ${fs.readFileSync(OUTPUT_REL, 'utf8').split('\n').length} 行 → ${OUTPUT_REL}`,
);
