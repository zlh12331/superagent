import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../packages/shared/src/constants/errors';

const LOCALES_DIR = join(import.meta.dirname, '../../src/renderer/i18n/locales');

/** 递归收集对象 key 集合（key 路径用 '.' 拼接，叶子值为 key） */
function collectKeys(value: unknown, prefix = '', keys = new Set<string>()): Set<string> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      collectKeys(child, path, keys);
    }
  } else {
    keys.add(prefix);
  }
  return keys;
}

/** 加载语言包内容（语言包与命名空间一一对应、扁平无包装） */
function loadTranslation(lang: 'en' | 'zh-CN', ns: 'common' | 'errors'): unknown {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf-8'));
}

describe('i18n 资源一致性', () => {
  it('common.json：en 与 zh-CN key 集合一致', () => {
    const en = collectKeys(loadTranslation('en', 'common'));
    const zh = collectKeys(loadTranslation('zh-CN', 'common'));
    expect([...en].sort()).toEqual([...zh].sort());
  });

  it('errors.json：en 与 zh-CN key 集合一致', () => {
    const en = collectKeys(loadTranslation('en', 'errors'));
    const zh = collectKeys(loadTranslation('zh-CN', 'errors'));
    expect([...en].sort()).toEqual([...zh].sort());
  });

  it('errors.json：en/zh-CN 均覆盖全部 ErrorCode', () => {
    const allCodes = new Set<string>(Object.values(ErrorCode));
    for (const lang of ['en', 'zh-CN'] as const) {
      const keys = collectKeys(loadTranslation(lang, 'errors'));
      const missing = [...allCodes].filter((code) => !keys.has(`errors.${code}`));
      expect(missing, `${lang} 缺失错误码文案：${missing.join(', ')}`).toEqual([]);
    }
  });
});
