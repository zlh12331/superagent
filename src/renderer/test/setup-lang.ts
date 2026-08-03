// src/renderer/test/setup-lang.ts
// 渲染层测试语言固定（必须在 setup.ts 之前执行）
// ──────────────────────────────────────────────────────────────
// jsdom 的 navigator.language 为 en-US，LanguageDetector 会误检测为英文。
// 在 i18n 模块（initI18n）加载前写入 localStorage（检测顺序：localStorage > navigator），
// 确保组件内 t() 返回默认中文文案，测试断言保持中文。
// vitest setupFiles 按数组顺序执行，本文件排在 setup.ts 之前。
// ──────────────────────────────────────────────────────────────

if (typeof localStorage !== 'undefined') {
  localStorage.setItem('code-agent:lang', 'zh-CN');
}
