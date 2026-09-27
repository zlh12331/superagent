// scripts/lib/i18n-hardcoded-scan.test.ts
// 硬编码中文扫描核反例 fixture 测试：AST 主路径「违规样本必须命中 +
// 干净/豁免样本必须放过」+ 正则兜底路径的行为锚定
// ──────────────────────────────────────────────────────────────
// 盲区修复（2026-09-27）的三类新增覆盖各有一组正反样本：
// 多行 JSX 文本 / 字符串字面量属性 / 表达式容器。旧逐行正则对三者均静默漏扫。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  type HardcodedZhHit,
  scanHardcodedZh,
  scanHardcodedZhByAst,
  scanHardcodedZhByRegex,
} from './i18n-hardcoded-scan';

/** AST 命中断言：解析失败（null）显式失败，返回非空数组供后续断言 */
function expectAstHits(src: string, length: number): readonly HardcodedZhHit[] {
  const hits = scanHardcodedZhByAst(src);
  expect(hits, 'AST 解析不应失败（返回 null）').not.toBeNull();
  const list = hits ?? [];
  expect(list).toHaveLength(length);
  return list;
}

/** 模板占位符前缀（避免测试源码里出现字面 ${ 触发 noTemplateCurlyInString） */
const DOLLAR = '$';

describe('AST 主路径 · 违规样本必须命中', () => {
  it('多行 JSX 文本节点：跨行中文 → 命中文本节点起始行（旧单行正则漏扫）', () => {
    const src = [
      'export const A = () => (',
      '  <div>',
      '    第一行',
      '    第二行中文',
      '  </div>',
      ');',
    ].join('\n');
    const hits = expectAstHits(src, 1);
    expect(hits[0]?.kind).toBe('jsx-text');
    // JSXText 节点起始于 `<div>` 标签同行（紧跟标签闭合符），行号取节点起点
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.snippet).toContain('第一行');
  });

  it('字符串字面量属性：title="中文" → 命中（旧实现完全无匹配）', () => {
    const src = `export const A = () => <X title="中文标题" />;`;
    const hits = expectAstHits(src, 1);
    expect(hits[0]?.kind).toBe('attribute');
    expect(hits[0]?.line).toBe(1);
  });

  it('属性表达式容器：label={cond ? "是" : "否"} → 命中且归类 attribute', () => {
    const src = `export const A = () => <X label={cond ? '是' : '否'} />;`;
    const hits = expectAstHits(src, 2);
    expect(hits.every((h) => h.kind === 'attribute')).toBe(true);
  });

  it('表达式容器：{cond ? 中文 : 英文} → 命中（旧实现因含 {} 被显式排除）', () => {
    const src = `export const A = () => <span>{cond ? '是' : 'no'}</span>;`;
    const hits = expectAstHits(src, 1);
    expect(hits[0]?.kind).toBe('expression');
  });

  it('表达式容器模板串：内插前后含中文 → 命中', () => {
    const src = `export const A = () => <span>{\`前缀${DOLLAR}{x}中文\`}</span>;`;
    const hits = expectAstHits(src, 1);
    expect(hits[0]?.kind).toBe('expression');
  });

  it('普通元素单行文本：>中文< → 命中（旧行为回归保护）', () => {
    const src = `export const A = () => <div>你好世界</div>;`;
    const hits = expectAstHits(src, 1);
    expect(hits[0]?.kind).toBe('jsx-text');
  });
});

describe('AST 主路径 · 干净/豁免样本必须放过', () => {
  it('t() 调用的 ASCII key 不命中', () => {
    const src = `export const A = () => <div>{t('chat.title')}</div>;`;
    expectAstHits(src, 0);
  });

  it('属性经 t() 表达式传递不命中', () => {
    const src = `export const A = () => <X title={t('chat.title')} placeholder={t('chat.ph')} />;`;
    expectAstHits(src, 0);
  });

  it('纯英文 JSX 不命中', () => {
    const src = `export const A = () => <div><span>hello world</span></div>;`;
    expectAstHits(src, 0);
  });

  it('注释里的中文不命中（注释不是字符串字面量/文本节点）', () => {
    const src = ['// 中文注释', '/* 块中文注释 */', 'export const A = () => <div>ok</div>;'].join(
      '\n',
    );
    expectAstHits(src, 0);
  });

  it('非 JSX 上下文字符串（函数体内的 toast 文案）不在扫描域', () => {
    const src = `export function f(): string { const msg = '中文消息'; return msg; }`;
    expectAstHits(src, 0);
  });

  it('正则字面量与数字中的中文形态不命中', () => {
    const src = 'export const re = /[一-龥]/; export const n = 42;';
    expectAstHits(src, 0);
  });
});

describe('正则兜底路径（AST 解析失败时）', () => {
  it('语法错误输入 → AST 返回 null，组合入口退兜底并按行命中', () => {
    const broken = 'export const A = () => (<div>中文< </div>;';
    expect(scanHardcodedZhByAst(broken)).toBeNull();
    const hits = scanHardcodedZh(broken);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('兜底路径：含 t( 的行跳过（旧行为回归保护）', () => {
    const src = `<div title={t('chat.title')}>中文</div>; // 行内含 t( 调用`;
    expect(scanHardcodedZhByRegex(src)).toHaveLength(0);
  });

  it('兜底路径：注释行跳过', () => {
    const src = ['// 中文注释一', '* 中文注释二', '/* 中文注释三 */'].join('\n');
    expect(scanHardcodedZhByRegex(src)).toHaveLength(0);
  });
});

describe('组合入口', () => {
  it('合法 tsx 走 AST 路径（kind 字段来自 AST 分类）', () => {
    const src = `export const A = () => <X title="中文" />;`;
    const hits = scanHardcodedZh(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('attribute');
  });

  it('命中按行号升序', () => {
    const src = [
      'export const A = () => (',
      '  <div title="属性中文">',
      '    文本中文',
      '  </div>',
      ');',
    ].join('\n');
    const hits = scanHardcodedZh(src);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.map((h) => h.line)).toEqual([...hits.map((h) => h.line)].sort((a, b) => a - b));
  });
});
