// build-tokens.mjs：设计令牌构建 —— tokens/aurora.json（单一真源）→ src/renderer/styles/tokens.css（生成物，禁手改）
// 入口 pnpm tokens:build；一致性门禁 pnpm tokens:check 重跑本脚本比对产物，令牌契约见仓库根 DESIGN.md。
import fs from 'node:fs';
import StyleDictionary from 'style-dictionary';

// 路径按 cwd 解析（须从仓库根运行）：buildPath + destination 与 OUTPUT_REL、check-tokens-sync.ts 的
// TOKENS_OUTPUT 须指向同一文件——产物改址而未同步门禁，门禁会拿旧文件自比、静默放行。
const SOURCE = 'tokens/aurora.json';
const OUTPUT_REL = 'src/renderer/styles/tokens.css';
// 自定义 format：内置 format 不识别令牌的 dark 字段，故 :root / .dark 两段都在此生成
StyleDictionary.registerFormat({
  name: 'aurora/css',
  format: ({ dictionary }) => {
    const rootLines = [];
    const darkLines = [];
    for (const token of dictionary.allTokens) {
      const name = `--${token.name}`;
      const comment = token.comment !== undefined ? `  /* ${token.comment} */\n` : '';
      rootLines.push(`${comment}  ${name}: ${token.value};`);
      // 同值令牌不进 .dark：值一样，写进去只是把声明重复一遍，不构成覆盖
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
