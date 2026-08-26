// i18next-cli 配置（i18n 开发辅助：status 健康报告 + lint 漏翻检测）
// 依据 docs/design/14-i18n-spec.md（方案 1：只读辅助，不写语言包、不接门禁；
// 真正的 i18n 卡关门禁是自研 scripts/check-i18n.ts）
// ⚠️ 已知限制（2026-08-27 实测）：本项目语言包带 "translation" 顶层包装（i18next
// 命名空间约定），i18next-cli 按扁平 key 结构读取 → status 会把全部 key 计为缺失。
// 待上游支持 namespace 包装结构后再启用；当前仅作配置占位。
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
