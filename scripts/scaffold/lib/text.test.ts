// scripts/scaffold/lib/text.test.ts
import { describe, expect, it } from 'vitest';

import {
  escapeRegExp,
  insertAfterLastLine,
  insertBeforeAnchor,
  insertIntoObjectBlock,
  insertSortedLine,
} from './text';

const META_SAMPLE = `export const IPC_META = {
  app: {
    getStatus: request('app:getStatus'),
    openExternal: request('app:openExternal'),
  },

  chat: {
    send: request('chat:send'),
  },
} as const;
`;

describe('insertBeforeAnchor', () => {
  it('在锚点前插入块', () => {
    const result = insertBeforeAnchor(
      META_SAMPLE,
      '} as const;',
      "  demo: {\n    ping: request('demo:ping'),\n  },\n\n",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("  demo: {\n    ping: request('demo:ping'),\n  },\n\n} as const;");
  });

  it('锚点不存在返回 null', () => {
    expect(insertBeforeAnchor(META_SAMPLE, 'NOT_FOUND', 'x')).toBeNull();
  });
});

describe('insertIntoObjectBlock', () => {
  it('在块内末尾追加新行', () => {
    const result = insertIntoObjectBlock(
      META_SAMPLE,
      '  app: {',
      "    getInfo: request('app:getInfo'),",
    );
    expect(result).not.toBeNull();
    expect(result).toContain(
      "    openExternal: request('app:openExternal'),\n    getInfo: request('app:getInfo'),\n  },",
    );
  });

  it('块头不存在返回 null', () => {
    expect(insertIntoObjectBlock(META_SAMPLE, '  nope: {', 'x')).toBeNull();
  });

  it('不破坏其他块', () => {
    const result = insertIntoObjectBlock(
      META_SAMPLE,
      '  app: {',
      "    getInfo: request('app:getInfo'),",
    );
    expect(result).toContain("  chat: {\n    send: request('chat:send'),\n  },");
  });
});

describe('insertAfterLastLine', () => {
  it('在最后匹配行后追加', () => {
    const source = 'a\nb\nc\n';
    const result = insertAfterLastLine(source, /^[a-z]$/m, '\nNEW');
    expect(result).toBe('a\nb\nc\nNEW\n');
  });

  it('无匹配返回 null', () => {
    expect(insertAfterLastLine('x', /^\d+$/m, 'y')).toBeNull();
  });
});

describe('insertSortedLine', () => {
  const Imports = `import { createListDirectoryTool } from './list-directory.tool';\nimport { createReadFileTool } from './read-file.tool';\nimport { createWriteFileTool } from './write-file.tool';\n`;

  it('中间插入保持字典序', () => {
    const newLine = "import { createMyTool } from './my-tool.tool';";
    const result = insertSortedLine(
      Imports,
      /^import \{ create\w+Tool \} from '\.\/[a-z0-9-]+\.tool';$/m,
      newLine,
      (l) => l,
    );
    expect(result).toBe(
      "import { createListDirectoryTool } from './list-directory.tool';\nimport { createMyTool } from './my-tool.tool';\nimport { createReadFileTool } from './read-file.tool';\nimport { createWriteFileTool } from './write-file.tool';\n",
    );
  });

  it('字典序最大时追加到末尾', () => {
    const newLine = "import { createZedTool } from './zed.tool';";
    const result = insertSortedLine(
      Imports,
      /^import \{ create\w+Tool \} from '\.\/[a-z0-9-]+\.tool';$/m,
      newLine,
      (l) => l,
    );
    expect(result).toContain(
      "import { createWriteFileTool } from './write-file.tool';\nimport { createZedTool } from './zed.tool';\n",
    );
  });

  it('无匹配行返回 null', () => {
    expect(insertSortedLine('no imports', /^import /m, 'x', (l) => l)).toBeNull();
  });
});

describe('insertSortedLine（export 场景，按 from 路径排序）', () => {
  const Exports = `export { createListDirectoryTool } from './list-directory.tool';
// 重新导出路径守卫，供其他工具复用
export { resolveWithinWorkspace } from './path-guard';
// 重新导出工具工厂函数，供外部按需使用
export { createReadFileTool } from './read-file.tool';
`;

  // 提取 from 路径（含扩展名场景，如 './my-tool.tool'）
  const FromPathRe = /from '(\.\/[a-z0-9.-]+)'/;
  const pathKey = (line: string): string => line.match(FromPathRe)?.[1] ?? line;

  it('含扩展名路径按 from 排序插入（my-tool 应位于 path-guard 前）', () => {
    const result = insertSortedLine(
      Exports,
      /^export \{ [A-Za-z]\w+ \} from '\.\/[a-z0-9.-]+';$/m,
      "export { createMyToolTool } from './my-tool.tool';",
      pathKey,
    );
    expect(result).not.toBeNull();
    const myIndex = result.indexOf('createMyToolTool');
    const guardIndex = result.indexOf('resolveWithinWorkspace');
    const readIndex = result.indexOf('createReadFileTool');
    expect(myIndex).toBeGreaterThan(-1);
    expect(myIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(readIndex);
  });
});

describe('escapeRegExp', () => {
  it('转义正则特殊字符', () => {
    expect(escapeRegExp('a.b[c]')).toBe('a\\.b\\[c\\]');
  });
});
