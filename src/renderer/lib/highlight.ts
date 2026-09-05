// src/renderer/lib/highlight.ts
// shiki 语法高亮管理模块（2026-09 渲染性能优化：语言按需加载）
// ──────────────────────────────────────────────────────────────
// 背景：
// - 旧实现从 'shiki' 顶层导入（= bundle-full），所有语言语法静态打进主包
//   （index chunk 4.4MB 主因）。仅缩减语言列表不会减小主包。
// - 本模块切换到 'shiki/bundle/web'（语言懒加载入口）：createHighlighter
//   只预载最热语言，其余语言首次遇到时才 loadLanguage 按需 code-split。
// - 单例 + 并发去重，供 Markdown.tsx（消息代码块）与 FileViewerPanel.tsx
//   （文件预览）共用，避免重复初始化 highlighter / 语言加载。
// ──────────────────────────────────────────────────────────────

import {
  createHighlighter,
  type DynamicImportLanguageRegistration,
  type Highlighter,
} from 'shiki/bundle/web';

/**
 * 预加载的热门语言（首帧/消息高亮高频覆盖）
 *
 * LLM 代码输出与工具调用面（formatJson 的 input/output 展示）主要落在
 * TS/JS/TSX/JSON/shell/python；预载这 8 种覆盖绝大多数场景。
 */
const PRELOADED_LANGS = [
  'typescript',
  'javascript',
  'jsx',
  'tsx',
  'bash',
  'shell',
  'json',
  'python',
] as const;

/**
 * 延迟加载语言模块表（显式动态 import map）
 *
 * 用 `import('shiki/langs/<id>.mjs')`（经 package.json exports `./*→./dist/*`
 * 解析到 @shikijs/langs 的独立 chunk），首次遇到对应语言时才被 Rollup
 * code-split 产出异步 chunk。禁止 import 整个 bundledLanguages（会把全部
 * 语言 chunk 打进产物）。未收录的语言由 normalizeLang 降级为 'text'。
 */
const DEFERRED_LANG_MODULES: Readonly<Record<string, DynamicImportLanguageRegistration>> = {
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
};

/**
 * 语言别名映射 → canonical lang ID
 *
 * 处理 Markdown/文件名中常用的语言缩写。
 */
const LANG_ALIASES: Readonly<Record<string, string>> = {
  sh: 'bash',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  md: 'markdown',
  yml: 'yaml',
  jsonc: 'json',
  shell: 'bash',
  zsh: 'bash',
  ts: 'typescript',
  js: 'javascript',
};

let _highlighter: Highlighter | null = null;
let _highlighterPromise: Promise<Highlighter> | null = null;

/** 已加载完成的语言集合（预载 + 动态加载完成） */
const loadedLangs = new Set<string>(PRELOADED_LANGS);

/** 动态加载中的 Promise（并发去重：同一语言只触发一次 loadLanguage） */
const loadingDictionary: Record<string, Promise<void> | undefined> = {};

/**
 * 获取 shiki highlighter（单例）
 *
 * 首次调用异步初始化（加载引擎 + 预载语言），后续调用返回缓存。
 * 供 Markdown / FileViewer 等需要语法高亮的组件复用，避免重复初始化。
 */
export function getHighlighter(): Promise<Highlighter> {
  if (_highlighter !== null) return Promise.resolve(_highlighter);
  if (_highlighterPromise === null) {
    _highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...PRELOADED_LANGS],
    }).then(
      (h) => {
        _highlighter = h;
        return h;
      },
      // 初始化失败清缓存：rejected promise 永久持有会导致本次会话
      // 内所有代码块无高亮（瞬时失败如 chunk 加载失败无法重试）
      (err) => {
        _highlighterPromise = null;
        throw err;
      },
    );
  }
  return _highlighterPromise;
}

/**
 * 确保指定语言已加载（未预载的延迟语言触发按需加载）
 *
 * 首次遇到 go/rust 等延迟语言时 await loadLanguage 直到就绪；
 * 已在集合内或非收录语言（'text' / 不在 DEFERRED 表）立即返回。
 *
 * @param h 已初始化的 highlighter（来自 getHighlighter）
 * @param lang canonical lang ID（normalizeLang 的产物）
 */
export async function ensureLangLoaded(h: Highlighter, lang: string): Promise<void> {
  if (lang === 'text' || loadedLangs.has(lang)) return;
  const load = DEFERRED_LANG_MODULES[lang];
  if (load === undefined) return; // 未收录 → 调用方 codeToHtml 抛错走 'text' fallback
  if (loadingDictionary[lang] === undefined) {
    loadingDictionary[lang] = h.loadLanguage(load).then(
      () => {
        loadedLangs.add(lang);
      },
      // 失败清缓存键：允许下一个代码块重试（否则永久降级纯文本）
      (err) => {
        delete loadingDictionary[lang];
        throw err;
      },
    );
  }
  await loadingDictionary[lang];
}

/**
 * 规范化语言标识（纯 canonical 解析）
 *
 * - 先过别名表解析出 canonical id（sh→bash, py→python 等）
 * - canonical 属于「预载集 ∪ 延迟加载表」→ 返回 canonical（ensureLangLoaded
 *   将负责按需加载，不再因未预载而静态降级）
 * - 其余（未知语言代号）→ 'text'（不高亮，但保留 pre 格式）
 *
 * 导出供 FileViewerPanel 等复用，确保别名解析逻辑一致。
 */
export function normalizeLang(lang: string): string {
  const resolved = LANG_ALIASES[lang] ?? lang;
  if (
    (PRELOADED_LANGS as readonly string[]).includes(resolved) ||
    Object.hasOwn(DEFERRED_LANG_MODULES, resolved)
  ) {
    return resolved;
  }
  return 'text';
}
