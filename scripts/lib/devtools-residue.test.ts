// scripts/lib/devtools-residue.test.ts
import { describe, expect, it } from 'vitest';

import { findDevtoolsResidue } from './devtools-residue';

describe('findDevtoolsResidue', () => {
  it('命中包名串（模块被打回产物图的典型形态）', () => {
    const hits = findDevtoolsResidue([
      { file: 'renderer/assets/index.js', content: 'import("@tanstack/react-query-devtools")' },
    ]);
    expect(hits).toEqual([{ file: 'renderer/assets/index.js', line: 1 }]);
  });

  it('命中组件名（sourcemap sourcesContent 保留源码原文的形态）', () => {
    const hits = findDevtoolsResidue([
      {
        file: 'renderer/assets/index.js.map',
        content: '{"sourcesContent":["export function ReactQueryDevtools() {}"]}',
      },
    ]);
    expect(hits).toEqual([{ file: 'renderer/assets/index.js.map', line: 1 }]);
  });

  it('报告首个命中的行号', () => {
    const hits = findDevtoolsResidue([
      { file: 'a.js', content: 'const a = 1;\nconst b = ReactQueryDevtools;\nconst c = 2;' },
    ]);
    expect(hits).toEqual([{ file: 'a.js', line: 2 }]);
  });

  it('多文件多命中逐条返回', () => {
    const hits = findDevtoolsResidue([
      { file: 'a.js', content: 'react-query-devtools' },
      { file: 'b.js', content: 'clean' },
      { file: 'c.js', content: 'ReactQueryDevtools' },
    ]);
    expect(hits.map((h) => h.file)).toEqual(['a.js', 'c.js']);
  });

  it('干净产物零命中（含易误报的相邻串：react-query 本体 / electron-devtools-installer）', () => {
    const hits = findDevtoolsResidue([
      { file: 'a.js', content: 'import { QueryClient } from "@tanstack/react-query";' },
      { file: 'b.js', content: 'electron-devtools-installer 的 session.loadExtension' },
      { file: 'c.js', content: 'react-query' },
    ]);
    expect(hits).toEqual([]);
  });
});
