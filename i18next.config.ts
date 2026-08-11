// i18next-cli 配置（i18n 开发辅助：status 健康报告 + lint 漏翻检测）
// 依据 docs/design/14-i18n-spec.md（方案 1：只读辅助，不写语言包、不接门禁）
// 用法：
//   pnpm i18n:status    # 翻译健康报告（每命名空间进度）
//   pnpm i18n:lint      # 硬编码字符串检测（AST 启发式，漏翻审计）
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'zh-CN'],
  // 项目 config.ts defaultNS: 'common'；i18next-cli 默认 'translation'，必须对齐
  defaultNamespace: 'common',
  extract: {
    input: ['src/renderer/**/*.{ts,tsx}', '!**/__tests__/**', '!**/test/**'],
    output: 'src/renderer/i18n/locales/{{language}}/{{namespace}}.json',
  },
  sync: {
    primary: 'zh-CN',
  },
});
