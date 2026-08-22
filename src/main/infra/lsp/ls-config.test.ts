// src/main/infra/lsp/ls-config.test.ts
// 语言服务器解析单测：扩展名映射 / 命令行解析 / override 优先级

import { describe, expect, it } from 'vitest';
import {
  languageForFile,
  parseServerCommand,
  resolveLsServer,
  serverSpecForLanguage,
} from './ls-config';

describe('languageForFile', () => {
  it('ts/js 家族 → typescript（大小写不敏感）', () => {
    expect(languageForFile('C:\\proj\\src\\main.ts')).toBe('typescript');
    expect(languageForFile('/repo/App.TSX')).toBe('typescript');
    expect(languageForFile('/repo/index.mjs')).toBe('typescript');
    expect(languageForFile('/repo/server.d.ts')).toBe('typescript');
  });

  it('python/go/rust 映射', () => {
    expect(languageForFile('/repo/app.py')).toBe('python');
    expect(languageForFile('/repo/main.go')).toBe('go');
    expect(languageForFile('/repo/lib.rs')).toBe('rust');
  });

  it('未收录/无扩展名 → undefined', () => {
    expect(languageForFile('/repo/README.md')).toBeUndefined();
    expect(languageForFile('/repo/noext')).toBeUndefined();
  });
});

describe('parseServerCommand', () => {
  it('命令 + 参数拆分；多余空白归一', () => {
    expect(parseServerCommand('pyright-langserver --stdio')).toEqual({
      command: 'pyright-langserver',
      args: ['--stdio'],
    });
    expect(parseServerCommand('  my-lsp   --a 1  ')).toEqual({
      command: 'my-lsp',
      args: ['--a', '1'],
    });
  });

  it('裸命令（无参数）与空串', () => {
    expect(parseServerCommand('gopls')).toEqual({ command: 'gopls', args: [] });
    expect(parseServerCommand('   ')).toBeUndefined();
  });
});

describe('resolveLsServer / serverSpecForLanguage', () => {
  it('无覆盖：回落内置默认', () => {
    const resolved = resolveLsServer('/repo/a.ts');
    expect(resolved?.language).toBe('typescript');
    expect(resolved?.spec).toEqual({ command: 'typescript-language-server', args: ['--stdio'] });
  });

  it('有覆盖：override 优先于内置', () => {
    const overrides = { python: { command: 'custom-pylsp', args: ['-v'] } };
    const resolved = resolveLsServer('/repo/app.py', overrides);
    expect(resolved?.spec).toEqual({ command: 'custom-pylsp', args: ['-v'] });
    // 未覆盖语言不受影响
    expect(resolveLsServer('/repo/b.go', overrides)?.spec.command).toBe('gopls');
  });

  it('未收录文件类型 → undefined', () => {
    expect(resolveLsServer('/repo/x.md')).toBeUndefined();
  });

  it('非法 override（空 command）→ 回落内置', () => {
    expect(serverSpecForLanguage('rust', { rust: { command: '', args: [] } })).toEqual({
      command: 'rust-analyzer',
      args: [],
    });
  });
});
