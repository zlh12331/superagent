import fs from 'node:fs';
import StyleDictionary from 'style-dictionary';

const SOURCE = 'tokens/aurora.json';
const OUTPUT_REL = 'src/renderer/styles/tokens.css';
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
