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
import { type ComponentPropsWithoutRef, type ReactElement, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/hooks/use-copy';
import { useTranslation } from '@/i18n/use-translation';
import { ensureLangLoaded, getHighlighter, normalizeLang } from '@/lib/highlight';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';

// shiki highlighter 单例已移至 @/lib/highlight（2026-09 语言按需加载优化）：
// - getHighlighter()：createHighlighter 只预载热语言（'shiki/bundle/web' 入口）
// - normalizeLang()：canonical 解析（预载 ∪ 延迟表），不再静态降级
// - ensureLangLoaded()：首次遇到 go/rust 等延迟语言按需 loadLanguage
// 三者导出供 Markdown / FileViewerPanel 复用同一单例与加载去重表。
// ──────────────────────────────────────────────────────────────
// Markdown 主组件
// ──────────────────────────────────────────────────────────────

interface MarkdownProps {
  /** Markdown 文本 */
  content: string;
  /** 自定义容器类名 */
  className?: string;
  /**
   * 是否启用代码块语法高亮（默认 true）。
   * 流式消息传 false 跳过 shiki 高亮（对齐参考项目：流式期间用空 rehype 插件，
   * 避免每 token 到达都反复高亮长代码块的主线程开销；结束后自动恢复高亮）。
   */
  highlight?: boolean;
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
export function Markdown({ content, className, highlight = true }: MarkdownProps): ReactElement {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (props) => <CodeComponent {...props} highlight={highlight} />,
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
function CodeComponent({
  className,
  children,
  highlight = true,
}: ComponentPropsWithoutRef<'code'> & {
  /** 是否启用语法高亮（流式消息跳过高亮，对齐参考项目） */
  highlight?: boolean;
}): ReactElement {
  const match = /language-(\w+)/.exec(className ?? '');

  if (match === null) {
    // inline code
    return <code className="inline">{children}</code>;
  }

  const lang = match[1] ?? 'text';
  const code = String(children ?? '').replace(/\n$/, '');
  return <CodeBlock code={code} lang={lang} highlight={highlight} />;
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
function CodeBlock({
  code,
  lang,
  highlight = true,
}: {
  code: string;
  lang: string;
  /** 是否启用语法高亮（false 时渲染纯文本 pre，流式期间跳过 shiki 开销） */
  highlight?: boolean;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  // 复制反馈统一走 useCopy（copied 2s 复位 + 失败 toast）
  const { copied, copy } = useCopy();

  const normalizedLang = normalizeLang(lang);
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  // 异步高亮：code / lang / theme 变化时重新生成
  // highlight=false（流式期间）跳过高亮——仅渲染纯文本，避免每 token 反复高亮（对齐参考项目）
  // 2026-09 优化：高亮前先 ensureLangLoaded——首次遇到 go/rust 等延迟语言时
  // 按需 loadLanguage（await 到就绪再 codeToHtml），未收录语言走 fail-safe 降级
  useEffect(() => {
    if (!highlight) return;
    let cancelled = false;
    void (async () => {
      try {
        const h = await getHighlighter();
        if (cancelled) return;
        await ensureLangLoaded(h, normalizedLang);
        if (cancelled) return;
        const result = h.codeToHtml(code, { lang: normalizedLang, theme });
        setHtml(result);
      } catch {
        // lang 不支持 / loadLanguage 失败等异常：降级为纯文本 pre
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, normalizedLang, theme, highlight]);

  const handleCopy = async (): Promise<void> => {
    await copy(code);
  };

  return (
    // group 容器：头栏 + 高亮区（对齐参考项目 CodeBlock：rounded-lg border + 头栏）
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card">
      {/* 头栏：语言标签（font-mono uppercase 小字） + 悬浮复制按钮 */}
      <div className="border-border bg-muted/30 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">
          {normalizedLang}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'text-muted-foreground hover:text-foreground absolute top-2 right-2 size-6 hover:bg-transparent',
            copied && 'text-accent',
            'opacity-0 group-hover:opacity-100',
          )}
          onClick={handleCopy}
          aria-label={copied ? t('common.copied') : t('common.copyCode')}
          title={copied ? t('common.copied') : t('common.copyCode')}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      {/* 高亮区（overflow-x-auto 防长行溢出） */}
      <div className="overflow-x-auto">
        {html !== null ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出为可信的语法高亮 HTML（不来自用户输入）
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
