// scripts/lib/changelog-polish.test.ts
// CHANGELOG 润色判定单测（fixture 取自真实 CHANGELOG.md 的机器原文形态）
import { describe, expect, it } from 'vitest';

import {
  hasPolishedMarker,
  isMachineGenerated,
  needsPolish,
  POLISH_MARKER,
  parseVersionSections,
  sectionText,
} from './changelog-polish';

/** 机器生成的 bullet（conventional-changelog 形态：提交链接结尾） */
const MACHINE_A =
  '* **memory:** 修复引擎子进程从未启动（tsx 注入失效 + pid 竞态误判） ([08942aa](https://github.com/zlh12331/superagent/commit/08942aaedc0229096354b284f52f2fc957dc0102))';
/** 机器生成的 bullet（同时带 PR 链接与提交链接） */
const MACHINE_B =
  '* **renderer:** 渲染层全域审计收口 ([#44](https://github.com/zlh12331/superagent/issues/44)) ([b7a075c](https://github.com/zlh12331/superagent/commit/b7a075c70a6b599d9b42c96a7d79faa653868dc8))';
/** 人工润色后的 bullet（无提交链接） */
const POLISHED = '- **记忆功能**：修复记忆引擎子进程从未启动，此前记忆能力一直静默降级为「无记忆」';

const MACHINE_SECTION = [
  '## [1.1.1](https://github.com/zlh12331/superagent/compare/v1.1.0...v1.1.1) (2026-09-17)',
  '',
  '### Bug Fixes',
  '',
  MACHINE_A,
  MACHINE_B,
  '',
].join('\n');

const POLISHED_SECTION = [
  '## [1.1.1](https://github.com/zlh12331/superagent/compare/v1.1.0...v1.1.1) (2026-09-17)',
  '',
  '### 修复',
  '',
  POLISHED,
  '',
].join('\n');

const MULTI_VERSION = [
  '# Changelog',
  '',
  '## [1.2.0](https://example.com/compare) (2026-10-01)',
  '',
  '### 新增',
  '',
  '- 新功能说明',
  '',
  '## [1.1.1](https://example.com/compare) (2026-09-17)',
  '',
  '### Bug Fixes',
  '',
  MACHINE_A,
  '',
  '## [1.1.0](https://example.com/compare) (2026-09-14)',
  '',
  '### Features',
  '',
  '- 记忆引擎 vendoring 集成',
  '',
].join('\n');

describe('parseVersionSections', () => {
  it('正向：解析多版本段的版本号与行区间', () => {
    const sections = parseVersionSections(MULTI_VERSION);
    expect(sections.map((s) => s.version)).toEqual(['1.2.0', '1.1.1', '1.1.0']);
    // 首段从标题行开始，止于下一段标题行（endLine 为不含的上界）
    expect(sections[0]?.startLine).toBe(2);
    expect(sections[0]?.endLine).toBe(8);
    // 末段延伸至文件末尾
    expect(sections[2]?.endLine).toBe(MULTI_VERSION.split('\n').length);
  });

  it('边界：无版本段 → 空数组', () => {
    expect(parseVersionSections('# Changelog\n\n暂无发布。\n')).toEqual([]);
  });

  it('边界：prerelease 后缀版本号可解析', () => {
    const md = '## [1.2.0-beta.3](https://example.com) (2026-10-01)\n\n- x\n';
    expect(parseVersionSections(md).map((s) => s.version)).toEqual(['1.2.0-beta.3']);
  });

  it('边界：无链接的裸版本标题可解析', () => {
    const md = '## 1.0.0 (2026-09-10)\n\n- x\n';
    expect(parseVersionSections(md).map((s) => s.version)).toEqual(['1.0.0']);
  });
});

describe('sectionText', () => {
  it('正向：截取含标题行、不含下一段标题行', () => {
    const sections = parseVersionSections(MULTI_VERSION);
    const first = sections[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const text = sectionText(MULTI_VERSION, first);
    expect(text).toContain('## [1.2.0]');
    expect(text).not.toContain('## [1.1.1]');
  });
});

describe('isMachineGenerated', () => {
  it('正向：全部 bullet 带提交链接 → 机器原文', () => {
    expect(isMachineGenerated(MACHINE_SECTION)).toBe(true);
  });

  it('正向：人工润色（无提交链接）→ 非机器原文', () => {
    expect(isMachineGenerated(POLISHED_SECTION)).toBe(false);
  });

  it('边界：只要有一条 bullet 不带链接即视为已介入', () => {
    const mixed = `${MACHINE_SECTION}\n- 手工补充的一条说明\n`;
    expect(isMachineGenerated(mixed)).toBe(false);
  });

  it('边界：无 bullet 的段不判为机器原文（避免空段误报）', () => {
    const empty = '## [1.1.1](https://example.com) (2026-09-17)\n\n暂无记录。\n';
    expect(isMachineGenerated(empty)).toBe(false);
  });

  it('边界：`-` 与 `*` 两种 bullet 标记都能识别', () => {
    const dash = `${MACHINE_A.replace('* **memory', '- **memory')}\n`;
    expect(isMachineGenerated(dash)).toBe(true);
  });

  it('边界：仅标题与分组小标题（无 bullet）不判为机器原文', () => {
    const headings = '## [1.1.1](https://example.com)\n\n### Bug Fixes\n';
    expect(isMachineGenerated(headings)).toBe(false);
  });
});

describe('needsPolish / POLISH_MARKER', () => {
  it('正向：机器原文且无标记 → 需要润色', () => {
    expect(needsPolish(MACHINE_SECTION)).toBe(true);
  });

  it('正向：人工润色 → 不需要润色', () => {
    expect(needsPolish(POLISHED_SECTION)).toBe(false);
  });

  it('边界：机器原文 + 显式放行标记 → 不需要润色', () => {
    const signed = `${MACHINE_SECTION}\n${POLISH_MARKER}\n`;
    expect(hasPolishedMarker(signed)).toBe(true);
    expect(needsPolish(signed)).toBe(false);
  });

  it('边界：标记写在段外不生效（仅识别传入文本）', () => {
    expect(hasPolishedMarker(MACHINE_SECTION)).toBe(false);
  });
});
