// i18next-cli 配置（i18n 开发辅助：status 健康报告 + lint 漏翻检测）
// 依据 docs/design/14-i18n-spec.md（方案 1：只读辅助，不写语言包、不接门禁；
// 真正的 i18n 卡关门禁是自研 scripts/check-i18n.ts）
// 2026-09-17：语言包已移除 "translation" 顶层包装、改为扁平结构——
// 此前包装导致按扁平 key 读取的 i18next-cli / IDE i18n 插件把全部 key 计为缺失
// （IDE 侧表现为大量「文案路径」假阳性问题）。包装移除后本配置可正常消费。
// 用法：
//   pnpm i18n:status    # 翻译健康报告（每命名空间进度）
//   pnpm i18n:lint      # 硬编码字符串检测（AST 启发式，漏翻审计）
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  locales: ['en', 'zh-CN'],
  extract: {
    input: ['src/renderer/**/*.{ts,tsx}', '!**/*.test.*', '!**/test/**'],
    output: 'src/renderer/i18n/locales/{{language}}/{{namespace}}.json',
    // 项目 config.ts defaultNS: 'common'；i18next-cli 默认 'translation'，必须对齐
    // biome-ignore lint/style/useNamingConvention: defaultNS 是 i18next-cli 上游 API 属性名，不可改
    defaultNS: 'common',
  },
  // 注：i18next-cli 当前类型（I18nextToolkitConfig）无 sync 字段——
  // 状态报告/漏翻检测仅消费 locales + extract，占位语义不受影响
});
