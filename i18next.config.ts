// i18next.config.ts：i18next-cli 配置——开发辅助的翻译健康报告与漏翻检测
// 只读辅助，不写语言包、不接门禁；CI 卡关的 i18n 门禁是 pnpm check:i18n（scripts/check-i18n.ts）
// 用法：pnpm i18n:status（各命名空间翻译进度）/ pnpm i18n:lint（硬编码文案审计）
import { defineConfig } from 'i18next-cli';

export default defineConfig({
  // 首项即 i18next-cli 的基准语言（primaryLanguage 缺省取 locales[0]）：报告以它为参照，调序等于换参照
  locales: ['en', 'zh-CN'],
  extract: {
    input: ['src/renderer/**/*.{ts,tsx}', '!**/*.test.*', '!**/test/**'],
    // 需与 src/renderer/i18n/config.ts 静态 import 的语言包路径一致（一命名空间一文件）：
    // status / lint 按此模板定位语言包，模板漂移后工具读到的就不是运行时加载的那批文件
    output: 'src/renderer/i18n/locales/{{language}}/{{namespace}}.json',
    // 必须与 src/renderer/i18n/config.ts 的 defaultNS 对齐：i18next-cli 上游缺省 'translation'，
    // 不对齐则无 ns 前缀的 key 归入本仓并不存在的 'translation' 命名空间，统计整片失真
    // biome-ignore lint/style/useNamingConvention: defaultNS 是 i18next-cli 上游 API 属性名，不可改
    defaultNS: 'common',
  },
});
