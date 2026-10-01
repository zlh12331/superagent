// src/renderer/components/common/diff/DiffRowsTable.tsx
// 自研 diff 双栏表格（2026-09 替换 react-diff-viewer-continued，消除其拖入的语言 chunk 依赖树）
// ──────────────────────────────────────────────────────────────
// 数据流：DiffRow 行模型（unified-diff 解析 / diff-rows 文本对装配）
//   → 单 <table> 分组渲染（unified diff 每 hunk 一个 <tbody>，语义上仍是一张表）
// 视觉：tokens 语义色（新增 success 混色 / 删除 error 混色 / 行号 text-faint），
//   对齐既有 diff 行基调（cards.css 的 approval-diff-wrapper 与 FileChangeCard 配方）。
// 高亮：shiki 按需加载（lib/highlight 单例）——异步为可见行计算 token 着色，
//   失败/未收录语言一律退化为纯文本（fail-safe，不阻塞首帧）。
// 词级：wordDiff 开启时，配对的 del/add 行内以 dmp 片段高亮变更词（词级优先于语法色）。
// 大 diff：行数预算内渲染，超出折叠进「展开更多」按钮（键盘可达的原生 button），
//   每次展开追加固定行数，避免一次性铺设超大 DOM。
// a11y：语义 table/th/td；行号列 aria-hidden（读屏顺序读代码内容即可）；
//   增删标记用真实文本「+/-」而非纯色（FileChangeCard 同款）。
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useEffect, useState } from 'react';
import type { BundledLanguage } from 'shiki/bundle/web';
import type { ThemedToken } from 'shiki/core';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { computeWordSegments, type DiffRow, type WordSegment } from '@/lib/diff/diff-rows';
import { ensureLangLoaded, getHighlighter } from '@/lib/highlight';
import { cn } from '@/lib/utils';
import { useTheme } from '@/providers/ThemeProvider';

/** 首屏渲染行数预算（超出折叠，防大 diff 一次性铺 DOM 卡顿） */
const INITIAL_VISIBLE_ROWS = 400;
/** 每次「展开更多」追加的行数（保持单次重渲染有界） */
const EXPAND_ROWS = 400;

/** DiffRowsTable props */
export interface DiffRowsTableProps {
  /** 行分组（unified diff：每 hunk 一组；文本对：单组） */
  readonly rowGroups: readonly (readonly DiffRow[])[];
  /** shiki 语言 ID（缺省 / 'text' → 不做语法高亮） */
  readonly lang?: string | undefined;
  /** 行内词级差异（配对 del/add 行内高亮变更词；缺省关闭） */
  readonly wordDiff?: boolean | undefined;
  /** 左栏（变更前）标题 */
  readonly leftTitle?: string | undefined;
  /** 右栏（变更后）标题 */
  readonly rightTitle?: string | undefined;
}

/** 行类型 → 行底色类（context 无底色；色值见 styles/diff.css，纯语义令牌） */
function rowToneClass(type: DiffRow['type']): string {
  if (type === 'add') return 'is-add';
  if (type === 'del') return 'is-del';
  return '';
}

/** 词级片段是否可用（空数组 = 超长守卫触发，退化为整行渲染） */
function usableSegments(segments: readonly WordSegment[]): readonly WordSegment[] | undefined {
  return segments.length > 0 ? segments : undefined;
}

/**
 * 取一行的词级片段（wordDiff 模式）
 *
 * 配对规则：del 与紧随其后的 add 互为配对（git/文本对齐的典型形态）。
 * del 行渲染 old 侧片段（equal+del），add 行渲染 new 侧片段（equal+add）。
 * 未配对 / 未开启 → undefined（退化为整行渲染）。
 */
function wordSegmentsFor(
  row: DiffRow,
  prev: DiffRow | undefined,
  next: DiffRow | undefined,
  wordDiff: boolean,
): readonly WordSegment[] | undefined {
  if (!wordDiff || row.type === 'context') return undefined;
  const isDel = row.type === 'del';
  const other = isDel ? next : prev;
  if (other === undefined || other.type !== (isDel ? 'add' : 'del')) return undefined;
  const oldLine = isDel ? row.text : other.text;
  const newLine = isDel ? other.text : row.text;
  const segments = computeWordSegments(oldLine, newLine);
  if (segments.length === 0) return undefined;
  const wanted = isDel ? ['equal', 'del'] : ['equal', 'add'];
  return usableSegments(segments.filter((s) => wanted.includes(s.type)));
}

/** 代码内容渲染优先级：词级片段 > shiki token > 纯文本 */
function CodeContent({
  text,
  tokens,
  segments,
}: {
  readonly text: string;
  readonly tokens: readonly ThemedToken[] | undefined;
  readonly segments: readonly WordSegment[] | undefined;
}): ReactElement {
  if (text === '') return <span>{'\u200B'}</span>; // 空行保高度
  if (segments !== undefined) {
    // key 用片段在行内的起始偏移（顺序拼接，天然唯一且语义稳定）
    let segOffset = 0;
    return (
      <>
        {segments.map((seg) => {
          const key = segOffset;
          segOffset += seg.text.length;
          return (
            <span key={key} className={cn(seg.type !== 'equal' && `word-${seg.type}`)}>
              {seg.text}
            </span>
          );
        })}
      </>
    );
  }
  if (tokens !== undefined) {
    return (
      <>
        {tokens.map((token) => (
          // shiki token 的 offset 为行内起始偏移（唯一）；输出为已转义文本 + 主题色
          <span key={token.offset} style={{ color: token.color }}>
            {token.content}
          </span>
        ))}
      </>
    );
  }
  return <span>{text}</span>;
}

/** 单侧渲染单元（行号 + 代码）；该侧不承载内容时输出空单元格（双栏对齐） */
function DiffSideCells({
  row,
  side,
  tokens,
  segments,
}: {
  readonly row: DiffRow;
  readonly side: 'old' | 'new';
  readonly tokens: readonly ThemedToken[] | undefined;
  readonly segments: readonly WordSegment[] | undefined;
}): ReactElement {
  const inactive = side === 'old' ? row.type === 'add' : row.type === 'del';
  if (inactive) {
    return (
      <>
        <td className="diff-gutter" aria-hidden="true" />
        <td className="diff-code" />
      </>
    );
  }
  const number = side === 'old' ? row.oldNumber : row.newNumber;
  return (
    <>
      {/* 行号冗余于读屏（代码顺序可读），aria-hidden 避免逐行念数字 */}
      <td className="diff-gutter" aria-hidden="true">
        {number}
      </td>
      <td className={cn('diff-code', rowToneClass(row.type))}>
        {row.type !== 'context' && (
          // 增删标记：真实文本（读屏可感知）， FileChangeCard 同款语义
          <span className="diff-marker" aria-hidden="true">
            {row.type === 'add' ? '+' : '-'}
          </span>
        )}
        <CodeContent text={row.text} tokens={tokens} segments={segments} />
      </td>
    </>
  );
}

/** 单行渲染（双栏 4 单元格） */
function DiffLineRow({
  row,
  prev,
  next,
  tokens,
  wordDiff,
}: {
  readonly row: DiffRow;
  readonly prev: DiffRow | undefined;
  readonly next: DiffRow | undefined;
  readonly tokens: readonly ThemedToken[] | undefined;
  readonly wordDiff: boolean;
}): ReactElement {
  const segments = wordSegmentsFor(row, prev, next, wordDiff);
  return (
    <tr className="diff-line">
      <DiffSideCells row={row} side="old" tokens={tokens} segments={segments} />
      <DiffSideCells row={row} side="new" tokens={tokens} segments={segments} />
    </tr>
  );
}

/**
 * 自研 diff 双栏表格（UnifiedDiffView 与审批预览共用）
 *
 * rowGroups 行分组 / lang 语法高亮语言 / wordDiff 词级差异 / 栏标题，见 DiffRowsTableProps。
 */
export function DiffRowsTable({
  rowGroups,
  lang,
  wordDiff,
  leftTitle,
  rightTitle,
}: DiffRowsTableProps): ReactElement {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [revealed, setRevealed] = useState(0);
  const [tokenLines, setTokenLines] = useState<readonly (readonly ThemedToken[])[] | null>(null);
  const limit = INITIAL_VISIBLE_ROWS + revealed * EXPAND_ROWS;

  // 预算分配：按组序消费行数预算，末组可截断（后续组整体折叠）
  const { visibleGroups, hiddenCount } = allocateVisibleGroups(rowGroups, limit);

  // 可见行的平铺文本（shiki 逐行 token 与可见行顺序 1:1 对应）
  const visibleText = visibleGroups.map((g) => g.map((r) => r.text).join('\n')).join('\n');

  useEffect(() => {
    if (lang === undefined || lang === 'text') {
      setTokenLines(null);
      return;
    }
    let cancelled = false;
    void computeTokenLines(visibleText, lang, resolvedTheme === 'dark').then((tokens) => {
      if (!cancelled) setTokenLines(tokens);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, visibleText, resolvedTheme]);

  const tokensByRow = mapTokensToRows(visibleGroups, tokenLines);

  return (
    <div className="diff-table-wrap" data-lang={lang}>
      <table className="diff-table">
        {/* 固定布局下的列宽（双栏各半），保证增删行左右垂直对齐 */}
        <colgroup>
          <col className="diff-col-gutter" />
          <col className="diff-col-code" />
          <col className="diff-col-gutter" />
          <col className="diff-col-code" />
        </colgroup>
        {(leftTitle !== undefined || rightTitle !== undefined) && (
          <thead>
            <tr>
              <th className="diff-title" colSpan={2} scope="col">
                {leftTitle}
              </th>
              <th className="diff-title" colSpan={2} scope="col">
                {rightTitle}
              </th>
            </tr>
          </thead>
        )}
        {visibleGroups.map((group) => (
          <tbody key={tbodyKey(group)}>
            {group.map((row, ri) => (
              <DiffLineRow
                // 双侧行号组合在组内天然唯一（del/add/context 行号均严格递增）
                key={`${row.oldNumber}-${row.newNumber}`}
                row={row}
                prev={ri > 0 ? group[ri - 1] : undefined}
                next={ri < group.length - 1 ? group[ri + 1] : undefined}
                tokens={tokensByRow.get(row)}
                wordDiff={wordDiff === true}
              />
            ))}
          </tbody>
        ))}
      </table>
      {hiddenCount > 0 && (
        // 折叠展开控件：Button 保证键盘可达（Enter/Space 触发）；密度由 .diff-more 收敛
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="diff-more"
          onClick={() => setRevealed((v) => v + 1)}
        >
          {t('diff.showMoreRows', { remaining: hiddenCount })}
        </Button>
      )}
    </div>
  );
}

/** 可见行计数（预算分配的辅助求和） */
function visibleRowCount(groups: readonly (readonly DiffRow[])[]): number {
  let n = 0;
  for (const group of groups) n += group.length;
  return n;
}

/** 预算分配：按组序消费行数预算（末组可截断），返回可见组与折叠行数 */
function allocateVisibleGroups(
  rowGroups: readonly (readonly DiffRow[])[],
  limit: number,
): { readonly visibleGroups: (readonly DiffRow[])[]; readonly hiddenCount: number } {
  const visibleGroups: (readonly DiffRow[])[] = [];
  let total = 0;
  let remaining = limit;
  for (const group of rowGroups) {
    total += group.length;
    if (remaining > 0) {
      const take = Math.min(group.length, remaining);
      visibleGroups.push(group.slice(0, take));
      remaining -= take;
    }
  }
  return { visibleGroups, hiddenCount: total - visibleRowCount(visibleGroups) };
}

/** token 行序列 → 行对象映射（渲染时按行取用；token 缺失的行跳过） */
function mapTokensToRows(
  visibleGroups: readonly (readonly DiffRow[])[],
  tokenLines: readonly (readonly ThemedToken[])[] | null,
): Map<DiffRow, readonly ThemedToken[]> {
  const tokensByRow = new Map<DiffRow, readonly ThemedToken[]>();
  if (tokenLines === null) return tokensByRow;
  let i = 0;
  for (const group of visibleGroups) {
    for (const row of group) {
      const tokens = tokenLines[i];
      if (tokens !== undefined) tokensByRow.set(row, tokens);
      i += 1;
    }
  }
  return tokensByRow;
}

/** shiki 异步取词法 token（失败/未收录语言返回 null，调用方退化为纯文本） */
async function computeTokenLines(
  text: string,
  lang: string,
  dark: boolean,
): Promise<readonly (readonly ThemedToken[])[] | null> {
  try {
    const h = await getHighlighter();
    await ensureLangLoaded(h, lang);
    const { tokens } = h.codeToTokens(text, {
      // lang 经 normalizeLang 收敛到「预载 ∪ 延迟表」内 canonical id，
      // ensureLangLoaded 已确保加载；codeToTokens 的形参类型比运行时窄，此处收窄对齐
      lang: lang as BundledLanguage,
      theme: dark ? 'github-dark' : 'github-light',
    });
    return tokens;
  } catch {
    return null;
  }
}

/** hunk 分组的 tbody key（首行行号对在 hunk 序列中跨文件单调递增，加组长构成唯一） */
function tbodyKey(group: readonly DiffRow[]): string {
  const first = group[0];
  return first === undefined ? 'empty' : `${first.oldNumber}-${first.newNumber}-${group.length}`;
}
