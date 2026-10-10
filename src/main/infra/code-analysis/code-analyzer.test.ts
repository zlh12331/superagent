import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getCodeAnalyzer, resetCodeAnalyzer } from './code-analyzer';

const TS_SOURCE = `import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

interface User {
  name: string;
}

type UserId = string;

class SessionService {
  private cache = new Map<string, string>();

  get(id: UserId): string | undefined {
    return this.cache.get(id);
  }
}

function createUser(name: string): User {
  return { name };
}
`;

describe('CodeAnalyzer（真实 WASM）', () => {
  beforeAll(() => {
    resetCodeAnalyzer();
  });

  afterAll(() => {
    resetCodeAnalyzer();
  });

  it('typescript：提取 import/interface/type/class/method/function 符号', async () => {
    const analyzer = getCodeAnalyzer();
    const result = await analyzer.analyze({ path: 'sample.ts', content: TS_SOURCE });

    expect(result.parseFailed).toBe(false);
    expect(result.language).toBe('typescript');

    const byName = (name: string) => result.symbols.find((s) => s.name === name);
    expect(byName('node:path')?.kind).toBe('import');
    expect(byName('User')?.kind).toBe('interface');
    expect(byName('UserId')?.kind).toBe('type');
    expect(byName('SessionService')?.kind).toBe('class');
    expect(byName('get')?.kind).toBe('method');
    expect(byName('createUser')?.kind).toBe('function');

    expect(byName('User')?.line).toBe(4);
    expect(byName('createUser')?.line).toBe(18);
  });

  it('javascript：支持 js 文件解析', async () => {
    const analyzer = getCodeAnalyzer();
    const result = await analyzer.analyze({
      path: 'script.js',
      content: 'function main() { return 1; }\nclass Foo {}\n',
    });
    expect(result.parseFailed).toBe(false);
    expect(result.language).toBe('javascript');
    expect(result.symbols.find((s) => s.name === 'main')?.kind).toBe('function');
    expect(result.symbols.find((s) => s.name === 'Foo')?.kind).toBe('class');
  });

  it('未知扩展名：回退 typescript 解析（parseFailed=false）', async () => {
    const analyzer = getCodeAnalyzer();
    const result = await analyzer.analyze({
      path: 'file.unknownext',
      content: 'const x = 1;\n',
    });
    expect(result.language).toBe('typescript');
    expect(result.parseFailed).toBe(false);
  });

  it('空内容：返回空符号且不失败', async () => {
    const analyzer = getCodeAnalyzer();
    const result = await analyzer.analyze({ path: 'empty.ts', content: '' });
    expect(result.parseFailed).toBe(false);
    expect(result.symbols).toEqual([]);
  });
});
