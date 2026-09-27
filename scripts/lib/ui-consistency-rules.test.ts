// scripts/lib/ui-consistency-rules.test.ts
// 写法一致性规则核反例 fixture 测试：七条规则逐一「违规样本必须命中 +
// 干净/豁免样本必须放过」
// ──────────────────────────────────────────────────────────────
// 背景外部审计点名判据内联零测试（L2 缺口）——本文件补齐。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  OWNED_CSS_BUTTON_CLASSES,
  scanUiConsistency,
  type UiScanFile,
} from './ui-consistency-rules';

const ruleIdsOf = (violations: ReturnType<typeof scanUiConsistency>): string[] => [
  ...new Set(violations.map((v) => v.rule)),
];

const scanOne = (relFile: string, content: string): UiScanFile[] => [
  { relFile, lines: content.split('\n') },
];

describe('七条规则 · 反例必须命中', () => {
  it('index-key：key={i} → 命中', () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', '<li key={i} />'));
    expect(ruleIdsOf(v)).toContain('index-key');
  });

  it("join-class：className join(' ') → 命中", () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', `className={[a, b].join(' ')}`));
    expect(ruleIdsOf(v)).toContain('join-class');
  });

  it("manual-unwrap：'data' in res → 命中", () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', `if ('data' in res) return res.data;`));
    expect(ruleIdsOf(v)).toContain('manual-unwrap');
  });

  it('raw-button：components 内裸 <button> → 命中', () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', '<button type="button">go</button>'));
    expect(ruleIdsOf(v)).toContain('raw-button');
  });

  it('try-finally：} finally { → 命中', () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', '} finally {\n  reset();\n}'));
    expect(ruleIdsOf(v)).toContain('try-finally');
  });

  it('inline-query-key：queryKey: [...] → 命中', () => {
    const v = scanUiConsistency(scanOne('hooks/a.ts', `useQuery({ queryKey: ['git', 'x'] })`));
    expect(ruleIdsOf(v)).toContain('inline-query-key');
  });

  it('direct-ipc：.tsx 内 window.api → 命中', () => {
    const v = scanUiConsistency(scanOne('components/a.tsx', 'await window.api.session.list({})'));
    expect(ruleIdsOf(v)).toContain('direct-ipc');
  });
});

describe('文件过滤', () => {
  it('direct-ipc / join-class：hooks/*.ts（桥接层职责）→ 豁免', () => {
    expect(
      ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', 'await window.api.session.list({})'))),
    ).toHaveLength(0);
  });

  it('raw-button：components/ui/**（Button 本体）→ 豁免', () => {
    expect(
      ruleIdsOf(scanUiConsistency(scanOne('components/ui/button.tsx', '<button type="button" />'))),
    ).toHaveLength(0);
  });

  it('inline-query-key：lib/query/keys.ts（常量定义处）→ 豁免', () => {
    expect(
      ruleIdsOf(
        scanUiConsistency(scanOne('lib/query/keys.ts', `export const K = ['git'] as const;`)),
      ),
    ).toHaveLength(0);
  });
});

describe('通用豁免', () => {
  it('纯注释行不构成信号', () => {
    const content = [
      '// - queryKey: [a, b] - 文档注释示例',
      '* await window.api.session.list({})',
    ].join('\n');
    expect(scanUiConsistency(scanOne('components/a.tsx', content))).toHaveLength(0);
  });

  it('上一行 noArrayIndexKey biome-ignore → index-key 豁免', () => {
    const content = [
      '// biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏静态拆分',
      '<li key={i} />',
    ].join('\n');
    expect(scanUiConsistency(scanOne('components/a.tsx', content))).toHaveLength(0);
  });

  it('raw-button：归属 styles/ 领域按钮类 → 豁免', () => {
    const content = ['<button', '  className="icon-btn"', '>'].join('\n');
    expect(scanUiConsistency(scanOne('components/a.tsx', content))).toHaveLength(0);
  });

  it('raw-button：aria-pressed 选择器语义（ToggleGroup 收敛路径）→ 豁免', () => {
    const content = ['<button', '  aria-pressed={on}', '>'].join('\n');
    expect(scanUiConsistency(scanOne('components/a.tsx', content))).toHaveLength(0);
  });

  it('OWNED_CSS_BUTTON_CLASSES 清单非空（防手滑清空导致全量误报）', () => {
    expect(OWNED_CSS_BUTTON_CLASSES.length).toBeGreaterThan(10);
  });
});

describe('mutation-on-error · useMutation 选项必须含 onError（块级判据）', () => {
  it('多行选项块缺 onError → 命中（违规定位在开括号行）', () => {
    const content = [
      'const m = useMutation({',
      '  mutationFn: save,',
      '  onSuccess: () => {},',
      '});',
    ].join('\n');
    expect(scanUiConsistency(scanOne('hooks/a.ts', content))).toEqual([
      { rule: 'mutation-on-error', file: 'hooks/a.ts', line: 1 },
    ]);
  });

  it('泛型形式 useMutation<T, E, V>({ 缺 onError → 命中', () => {
    const content = [
      'const m = useMutation<FileRes, Error, FileReq>({',
      '  mutationFn: write,',
      '});',
    ].join('\n');
    expect(ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', content)))).toContain(
      'mutation-on-error',
    );
  });

  it('块内 onError（共享 hook 引用 / 内联回滚逻辑均可）→ 放过', () => {
    const onErrorShorthand = [
      'const m = useMutation({',
      '  mutationFn: save,',
      '  onError,',
      '});',
    ].join('\n');
    const onErrorRollback = [
      'const m = useMutation({',
      '  mutationFn: save,',
      '  onError: (error, _v, ctx) => {',
      '    if (ctx?.prev !== undefined) rollback(ctx.prev);',
      '    toast.error(unwrapErrorMessage(error, getErrorMessage));',
      '  },',
      '});',
    ].join('\n');
    expect(ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', onErrorShorthand)))).toHaveLength(0);
    expect(ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', onErrorRollback)))).toHaveLength(0);
  });

  it('单行 useMutation({ onError: f }) → 放过', () => {
    const content = 'const m = useMutation({ mutationFn: save, onError: report });';
    expect(ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', content)))).toHaveLength(0);
  });

  it('块内注释提及 onError 不算数（注释行剔除后缺 onError → 命中）', () => {
    const content = [
      'const m = useMutation({',
      '  mutationFn: save,',
      '  // onError 由上层统一处理（实际未挂）',
      '});',
    ].join('\n');
    expect(ruleIdsOf(scanUiConsistency(scanOne('hooks/a.ts', content)))).toContain(
      'mutation-on-error',
    );
  });

  it('注释行提及 useMutation({ 不构成信号', () => {
    const content = '// useMutation({ mutationFn: save }) 缺 onError 的反例说明';
    expect(scanUiConsistency(scanOne('hooks/a.ts', content))).toHaveLength(0);
  });

  it('同文件多个 mutation：前者有 onError、后者缺失 → 只命中后者', () => {
    const content = [
      'const a = useMutation({',
      '  mutationFn: save,',
      '  onError,',
      '});',
      '',
      'const b = useMutation({',
      '  mutationFn: remove,',
      '});',
    ].join('\n');
    expect(scanUiConsistency(scanOne('hooks/a.ts', content))).toEqual([
      { rule: 'mutation-on-error', file: 'hooks/a.ts', line: 6 },
    ]);
  });
});
