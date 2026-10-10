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
        components={highlight ? COMPONENTS_HIGHLIGHTED : COMPONENTS_PLAIN}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * code 组件覆盖（高亮 / 纯文本两档）
 *
 * react-markdown 同时处理 inline code 和 block code：
 * - inline code（`` `text` ``）：无 language-* className → 渲染 <code class="inline">
 * - block code（```lang\n...\n```）：有 language-* className → 渲染 CodeBlock
 * - 无语言标注的围栏（```\n...\n```）不带 info string ⇒ className 为空 ⇒ 走 inline 分支
 *   （现状行为，见同目录 markdown.test.tsx）
 *
 * 两档写死为模块级常量而非在渲染内联定义：react-markdown 把 components[name] 直接
 * 当作元素 type，内联箭头每次渲染都是新 identity ⇒ React 视为不同类型而卸载重挂该
 * 子树，CodeBlock 的 useState（highlighted）/useCopy（copied）随之被重置（高亮结果
 * 闪回纯文本、复制反馈归零）。模块级常量 identity 恒定，杜绝重挂。
 */
const CodeHighlighted = (props: ComponentPropsWithoutRef<'code'>): ReactElement => (
  <CodeComponent {...props} highlight />
);

const CodePlain = (props: ComponentPropsWithoutRef<'code'>): ReactElement => (
  <CodeComponent {...props} highlight={false} />
);

const COMPONENTS_HIGHLIGHTED = { code: CodeHighlighted, pre: PreComponent, a: AnchorComponent };
const COMPONENTS_PLAIN = { code: CodePlain, pre: PreComponent, a: AnchorComponent };
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

/**
 * 代码块组件
 *
 * - shiki 异步高亮：首次 highlighter 未就绪时显示纯文本 fallback
 * - 主题跟随：resolvedTheme 变化时重新高亮
 * - 复制按钮：对齐原型 .code-block-wrapper + .code-copy-btn
 */
/** 高亮结果（与生成它的 code + theme 绑定，防旧 HTML 回显） */
interface HighlightResult {
  readonly html: string;
  readonly code: string;
  readonly theme: string;
}

/**
 * 高亮单段代码（模块级提取：shiki 异步管线）
 *
 * 高亮前先 ensureLangLoaded——首次遇到 go/rust 等延迟语言时按需 loadLanguage
 * （await 到就绪再 codeToHtml），未收录语言走 fail-safe 降级（返回 null → 纯文本 pre）。
 */
async function highlightCode(
  code: string,
  lang: string,
  theme: 'github-dark' | 'github-light',
  isCancelled: () => boolean,
): Promise<HighlightResult | null> {
  try {
    const h = await getHighlighter();
    if (isCancelled()) return null;
    await ensureLangLoaded(h, lang);
    if (isCancelled()) return null;
    return { html: h.codeToHtml(code, { lang, theme }), code, theme };
  } catch {
    return null;
  }
}

function CodeBlock({
  code,
  lang,
  highlight,
}: {
  code: string;
  lang: string;
  /** 是否启用语法高亮（false 时渲染纯文本 pre，流式期间跳过 shiki 开销） */
  highlight?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [highlighted, setHighlighted] = useState<HighlightResult | null>(null);
  const { copied, copy } = useCopy();

  const normalizedLang = normalizeLang(lang);
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  useEffect(() => {
    if (!highlight) return;
    let cancelled = false;
    void highlightCode(code, normalizedLang, theme, () => cancelled).then((result) => {
      if (!cancelled) setHighlighted(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, normalizedLang, theme, highlight]);

  const html =
    highlight && highlighted !== null && highlighted.code === code && highlighted.theme === theme
      ? highlighted.html
      : null;

  const handleCopy = async (): Promise<void> => {
    await copy(code);
  };

  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-border bg-muted/30 flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-2xs tracking-wider uppercase">
          {normalizedLang}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'text-muted-foreground hover:text-foreground absolute top-2 right-2 size-6 hover:bg-transparent',
            copied && 'text-accent',
            'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
          onClick={handleCopy}
          aria-label={copied ? t('common.copied') : t('common.copyCode')}
          title={copied ? t('common.copied') : t('common.copyCode')}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <div className="overflow-x-auto">
        {html !== null ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki codeToHtml 对代码内容做 HTML 转义，输出为可信的语法高亮标记
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
