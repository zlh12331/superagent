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
// - 代码块包裹 .code-block-wrapper，右上角 .code-copy-btn 复制按钮（hover/聚焦显示）
// - shiki highlighter 单例：首次调用异步初始化，后续同步访问
//
// 性能：
// - 流式期间由调用方传 highlight={false}（message-item 传 !isStreaming）跳过
//   shiki，避免每个 token 到达都重跑长代码块高亮；回合结束后自动恢复
// - shiki 语言数据是**本地打包 + 按需 code-split**（@/lib/highlight 走
//   'shiki/bundle/web' 与 import('shiki/langs/*.mjs')），不发 CDN 请求；
//   首次遇到延迟语言时按需加载，加载期间显示纯文本 fallback
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
        components={highlight ? COMPONENTS_HIGHLIGHTED : COMPONENTS_PLAIN}
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
 * code 组件覆盖（高亮 / 纯文本两档）
 *
 * react-markdown 同时处理 inline code 和 block code：
 * - inline code（`` `text` ``）：无 language-* className → 渲染 <code class="inline">
 * - block code（```lang\n...\n```）：有 language-* className → 渲染 CodeBlock
 * - 无语言标注的围栏（```\n...\n```）不带 info string ⇒ className 为空 ⇒ 走 inline 分支
 *   （现状行为，见 __tests__/markdown.test.tsx）
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
    // lang 不支持 / loadLanguage 失败等异常：降级为纯文本 pre
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
  // 本地化文案
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [highlighted, setHighlighted] = useState<HighlightResult | null>(null);
  // 复制反馈统一走 useCopy（copied 2s 复位 + 失败 toast）
  const { copied, copy } = useCopy();

  const normalizedLang = normalizeLang(lang);
  const theme: 'github-dark' | 'github-light' =
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light';

  // 异步高亮：code / lang / theme 变化时重新生成
  // highlight=false（流式期间）跳过高亮——仅渲染纯文本，避免每 token 反复高亮（对齐参考项目）
  // 结果与「生成它的 code + theme」绑定：code 变化到新结果 resolve 之间不回显旧 HTML
  // （此前只存 html，长代码块在流式/编辑时会出现旧内容闪现）
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

  // 仅当结果对应当前 code/theme 且启用高亮时使用；否则走纯文本 fallback
  const html =
    highlight && highlighted !== null && highlighted.code === code && highlighted.theme === theme
      ? highlighted.html
      : null;

  const handleCopy = async (): Promise<void> => {
    await copy(code);
  };

  return (
    // group 容器：头栏 + 高亮区（对齐参考项目 CodeBlock：rounded-lg border + 头栏）
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card">
      {/* 头栏：语言标签（font-mono uppercase 小字） + 悬浮复制按钮 */}
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
            // 键盘可达性（WCAG 2.4.7）：此前仅 group-hover 显形，Tab 聚焦到按钮时
            // 父容器仍 opacity-0——可聚焦但视觉不可见。补 group-focus-within（与
            // globals.css 中 .msg:focus-within .msg-actions 的既有修复同源）。
            'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
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
