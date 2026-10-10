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
  if (text === '') return <span>{'\u200B'}</span>;
  if (segments !== undefined) {
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
      <td className="diff-gutter" aria-hidden="true">
        {number}
      </td>
      <td className={cn('diff-code', rowToneClass(row.type))}>
        {row.type !== 'context' && (
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

  const { visibleGroups, hiddenCount } = allocateVisibleGroups(rowGroups, limit);

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
