// packages/shared/src/__tests__/settings-schema.test.ts
// settings schema 单测：P0 收口——settings:set key 白名单 + lsp 命令门
//
// 背景：key 曾为自由字符串，渲染层可覆写主进程消费的任意 app_settings 键
// 且持久化重启仍生效；lsp.serverCommands 值曾可为任意路径形态的可执行文件。

import { describe, expect, it } from 'vitest';
import { isSafeLsServerCommand, SETTING_KEYS, SettingsSetReqSchema } from '../schemas/settings';

describe('SETTING_KEYS 白名单', () => {
  it('覆盖渲染层全部持久化分组（含直写的 im.allowedGroups 与 memory/update 开关）', () => {
    expect(SETTING_KEYS).toEqual([
      'theme',
      'language',
      'ai',
      'editor',
      'shortcuts',
      'experimental',
      'lsp',
      'workspace',
      'browser',
      'update',
      'memory',
      'im.allowedGroups',
    ]);
  });
});

describe('SettingsSetReqSchema · key 白名单（P0）', () => {
  it('白名单内键通过', () => {
    for (const key of SETTING_KEYS) {
      expect(SettingsSetReqSchema.safeParse({ key, value: {} }).success).toBe(true);
    }
  });

  it('白名单外键拒绝（含主进程内部配置命名空间）', () => {
    for (const key of ['lsp2', 'runtime.models', 'im', '__proto__', 'theme.dark', '']) {
      expect(SettingsSetReqSchema.safeParse({ key, value: {} }).success).toBe(false);
    }
  });
});

describe('SettingsSetReqSchema · lsp.serverCommands 值级门禁（P0）', () => {
  it('PATH 裸可执行名通过（含参数）', () => {
    const result = SettingsSetReqSchema.safeParse({
      key: 'lsp',
      value: { serverCommands: { go: 'gopls', typescript: 'typescript-language-server --stdio' } },
    });
    expect(result.success).toBe(true);
  });

  it('路径形态可执行文件拒绝（UI 契约：需在 PATH 中安装）', () => {
    const result = SettingsSetReqSchema.safeParse({
      key: 'lsp',
      value: { serverCommands: { go: '/usr/local/bin/evil-ls' } },
    });
    expect(result.success).toBe(false);
  });

  it('ext:: 类传输串拒绝', () => {
    const result = SettingsSetReqSchema.safeParse({
      key: 'lsp',
      value: { serverCommands: { go: 'ext::evil' } },
    });
    expect(result.success).toBe(false);
  });

  it('非字符串值拒绝', () => {
    const result = SettingsSetReqSchema.safeParse({
      key: 'lsp',
      value: { serverCommands: { go: 42 } },
    });
    expect(result.success).toBe(false);
  });

  it('非 lsp 键不做值级校验（value unknown 放行）', () => {
    expect(SettingsSetReqSchema.safeParse({ key: 'theme', value: 'dark' }).success).toBe(true);
  });
});

describe('isSafeLsServerCommand', () => {
  it('裸可执行名（含点/横线）通过', () => {
    for (const value of ['gopls', 'rust-analyzer', 'pyright-langserver', 'gopls -remote=auto']) {
      expect(isSafeLsServerCommand(value)).toBe(true);
    }
  });

  it('路径分隔符/空串拒绝（空白分隔的参数不误伤：首 token 裸名即通过）', () => {
    for (const value of ['/usr/bin/gopls', 'C:\\tools\\gopls.exe', './evil', '', '  ']) {
      expect(isSafeLsServerCommand(value)).toBe(false);
    }
  });
});
