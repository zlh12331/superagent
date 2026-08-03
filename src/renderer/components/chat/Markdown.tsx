// src/renderer/components/chat/Markdown.tsx
// Markdown 渲染 + 代码语法高亮
// ──────────────────────────────────────────────────────────────
// 职责：
// - 使用 react-markdown + remark-gfm 解析 Markdown 文本
// - 使用 shiki 对代码块进行语法高亮（支持双主题切换）
// - 对齐原型 .code-block-wrapper + .code-copy-btn 设计
// ──────────────────────────────────────────────────────────────
//
// 设计：
// - inline code：渲染为 <code class="inline">，样式由 CSS .msg-content code.inline 提供
// - block code：shiki codeToHtml 异步高亮，生成带内联样式的 <pre>
// - 代码块包裹 .code-block-wrapper，右上角 .code-copy-btn 复制按钮（hover 显示）
// - shiki highlighter 单例：首次调用异步初始化，后续同步访问
//
// 性能：
// - 流式场景下 code 频繁变化，每次变化触发 codeToHtml（同步调用，通常 <5ms）
// - 首次加载时 shiki 需从 CDN 拉取语言数据，有短暂延迟（显示纯文本 fallback）
// ──────────────────────────────────────────────────────────────

import { Check, Copy } from 'lucide-react';
import {
  type ComponentPropsWithoutRef,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createHighlighter, type Highlighter } from 'shiki';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';

// ──────────────────────────────────────────────────────────────
// shiki highlighter 单例
// ──────────────────────────────────────────────────────────────

/**
 * 预加载的常用语言
 *
 * 未在此列表中的语言会降级为 'text'（不高亮，但保留 pre 格式）。
 */
const PRELOADED_LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'bash',
  'shell',
  'json',
  'python',
  'rust',
  'go',
  'java',
  'html',
  'css',
  'markdown',
  'sql',
  'yaml',
  'xml',
  'diff',
] as const;

/**
 * 语言别名映射 → shiki 标准 lang ID
 *
 * 处理 Markdown 中常用的语言缩写。
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

/**
 * 获取 shiki highlighter（单例）
 *
 * 首次调用异步初始化（加载 WASM + 语言数据），后续调用返回缓存。
 *
 * 导出供 FileViewerDialog 等其它需要语法高亮的组件复用，
 * 避免重复初始化 highlighter 实例（WASM + 语言数据加载成本高）。
 */
export function getHighlighter(): Promise<Highlighter> {
  if (_highlighter !== null) return Promise.resolve(_highlighter);
  if (_highlighterPromise === null) {
    _highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...PRELOADED_LANGS],
    }).then((h) => {
      _highlighter = h;
      return h;
    });
  }
  return _highlighterPromise;
}

/**
 * 规范化语言标识
 *
 * - 解析别名（sh → bash, py → python 等）
 * - 未预加载的语言降级为 'text'
 *
 * 导出供其它组件复用，确保别名解析逻辑一致。
 */
export function normalizeLang(lang: string): string {
  const resolved = LANG_ALIASES[lang] ?? lang;
  return (PRELOADED_LANGS as readonly string[]).includes(resolved) ? resolved : 'text';
}

// ──────────────────────────────────────────────────────────────
// Markdown 主组件
// ──────────────────────────────────────────────────────────────

interface MarkdownProps {
  /** Markdown 文本 */
  content: string;
  /** 自定义容器类名 */
  className?: string;
}

/**
 * Markdown 渲染组件
 *
 * 使用 react-markdown + remark-gfm 解析 GFM Markdown。
 * 代码块通过 shiki 进行语法高亮，主题跟随 useTheme。
 *
 * @example
 * ```tsx
 * <Markdown content={part.text} />
 * ```
 */
export function Markdown({ content, className }: MarkdownProps): ReactElement {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeComponent,
          pre: PreComponent,
          a: AnchorComponent,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// react-markdown 组件覆盖
// ──────────────────────────────────────────────────────────────

/**
 * code 组件覆盖
 *
 * react-markdown 同时处理 inline code 和 block code：
 * - inline code（`` `text` ``）：无 language-* className → 渲染 <code class="inline">
 * - block code（```lang\n...\n```）：有 language-* className → 渲染 CodeBlock
 */
function CodeComponent({ className, children }: ComponentPropsWithoutRef<'code'>): ReactElement {
  const match = /language-(\w+)/.exec(className ?? '');

  if (match === null) {
    // inline code
    return <code className="inline">{children}</code>;
  }

  const lang = match[1] ?? 'text';
  const code = String(children ?? '').replace(/\n$/, '');
  return <CodeBlock code={code} lang={lang} />;
}

/**
 * pre 组件覆盖
 *
 * CodeBlock 自己渲染 <pre>（通过 shiki codeToHtml），所以这里直接透传 children，
 * 避免双层 <pre> 嵌套。
 */
function PreComponent({ children }: ComponentPropsWithoutRef<'pre'>): ReactElement {
  return <>{children}</>;
}

/**
 * a 组件覆盖：外部链接在新窗口打开
 */
function AnchorComponent({ href, children }: ComponentPropsWithoutRef<'a'>): ReactElement {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// ──────────────────────────────────────────────────────────────
// CodeBlock 组件（shiki 异步高亮 + 复制按钮）
// ──────────────────────────────────────────────────────────────

/**
 * 代码块组件
 *
 * - shiki 异步高亮：首次 highlighter 未就绪时显示纯文本 fallback
 * - 主题跟随：resolvedTheme 变化时重新高亮
 * - 复制按钮：对齐原型 .code-block-wrapper + .code-copy-btn
 */
function CodeBlock({ code, lang }: { code: string; lang: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const normalizedLang = normalizeLang(lang);
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  // 异步高亮：code / lang / theme 变化时重新生成
  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((h) => {
        if (cancelled) return;
        try {
          const result = h.codeToHtml(code, { lang: normalizedLang, theme });
          setHtml(result);
        } catch {
          // lang 不支持等异常：降级为纯文本 pre
          setHtml(null);
        }
      })
      .catch(() => {
        // highlighter 初始化失败：降级为纯文本
        setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, normalizedLang, theme]);

  // copy 按钮 2s 复位定时器：组件卸载时清理，避免 setState on unmounted component 内存泄漏
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      // clipboard 不可用时静默失败
    }
  }, [code]);

  return (
    <div className="code-block-wrapper">
      <button
        type="button"
        className={cn('code-copy-btn', copied && 'copied')}
        onClick={handleCopy}
        aria-label={copied ? t('common.copied') : t('common.copyCode')}
        title={copied ? t('common.copied') : t('common.copyCode')}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
      {html !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML（不来自用户输入）
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
