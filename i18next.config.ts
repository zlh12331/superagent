import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'zh-CN'],
  extract: {
    input: ['src/renderer/**/*.{ts,tsx}', '!**/*.test.*', '!**/test/**'],
    output: 'src/renderer/i18n/locales/{{language}}/{{namespace}}.json',
    // biome-ignore lint/style/useNamingConvention: defaultNS 是 i18next-cli 上游 API 属性名，不可改
    defaultNS: 'common',
  },
});
