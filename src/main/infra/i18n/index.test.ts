// src/main/infra/i18n/index.test.ts
// 主进程 i18n 单测：双语 key 齐全 + 缺 key 回退 + 插值 + 语言态迁移
// ──────────────────────────────────────────────────────────────
// 「zh/en key 集合一致」在此守护（check-i18n 只扫渲染层语言包，主进程词典
// 不在其扫描域）。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';

import { MAIN_DICTIONARIES } from './dictionaries';
import { DEFAULT_MAIN_LANGUAGE, getMainLanguage, initMainI18n, setMainLanguage, t } from './index';

describe('词典完整性', () => {
  it('zh-CN 与 en key 集合完全一致（双向无缺失）', () => {
    const zhKeys = Object.keys(MAIN_DICTIONARIES['zh-CN'] ?? {}).sort();
    const enKeys = Object.keys(MAIN_DICTIONARIES.en ?? {}).sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('所有词条为非空字符串且不含换行', () => {
    for (const dict of Object.values(MAIN_DICTIONARIES)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.length, `${key} 为空`).toBeGreaterThan(0);
        expect(value, `${key} 含换行`).not.toMatch(/\r|\n/);
      }
    }
  });

  it('en 词条插值占位与 zh 对齐（同 key 占位集合一致）', () => {
    const zh = MAIN_DICTIONARIES['zh-CN'] ?? {};
    const en = MAIN_DICTIONARIES.en ?? {};
    const placeholders = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
    for (const [key, zhValue] of Object.entries(zh)) {
      const enValue = en[key];
      expect(enValue, `${key} 缺失于 en`).toBeDefined();
      expect(placeholders(enValue ?? '').sort(), `${key} 占位不一致`).toEqual(
        placeholders(zhValue ?? '').sort(),
      );
    }
  });
});

describe('语言态与 t()', () => {
  beforeEach(() => {
    initMainI18n(undefined);
  });

  it('未初始化/非法值 → 默认 zh-CN', () => {
    expect(getMainLanguage()).toBe('zh-CN');
    expect(t('tools.planMode.entered')).toBe('已进入计划模式');
    setMainLanguage('fr-FR');
    expect(getMainLanguage()).toBe('zh-CN');
  });

  it('initMainI18n 接受 settings 原始值（合法/未设置/损坏）', () => {
    initMainI18n('en');
    expect(t('tools.readFile.title', { path: 'a.ts' })).toBe('Read file: a.ts');
    initMainI18n(undefined);
    expect(t('tools.readFile.title', { path: 'a.ts' })).toBe('读取文件: a.ts');
    initMainI18n(null);
    expect(getMainLanguage()).toBe('zh-CN');
  });

  it('en 下缺 key 回退 zh-CN 词典，双缺返回 key 本身', () => {
    setMainLanguage('en');
    expect(t('totally.missing.key')).toBe('totally.missing.key');
  });

  it('插值：缺参保留 {name} 占位原文', () => {
    expect(t('tools.taskList.titleWithCount', { count: 3 })).toBe('任务列表: 3 条');
    expect(t('tools.taskList.titleWithCount')).toBe('任务列表: {count} 条');
  });

  it('默认语言常量导出与词典语言一致', () => {
    expect(DEFAULT_MAIN_LANGUAGE).toBe('zh-CN');
  });
});
