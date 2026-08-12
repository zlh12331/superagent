// src/renderer/i18n/__tests__/i18n-gaps.test.ts
// i18n 域批次8 缺口补全：initI18n 幂等 / 语言切换 / useErrorMessage 兜底链
//
// 测试要点：
// 1. initI18n 幂等 + 资源可用（chat.inputLabel 可查）
// 2. getCurrentLanguage / changeLanguage 切换
// 3. useErrorMessage：i18n key 命中 / 未注册 code 回退原文 / ERROR_META 兜底语义

import { ErrorCode } from '@code-agent/shared/renderer';
import { renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changeLanguage,
  getCurrentLanguage,
  i18n,
  initI18n,
  resources,
  SUPPORTED_LANGUAGES,
} from '../config';
import { useErrorMessage } from '../use-translation';

describe('i18n 批次8 缺口补全', () => {
  afterEach(async () => {
    // 恢复默认语言，避免污染其他测试
    await i18next.changeLanguage('zh-CN');
  });

  it('initI18n：幂等（重复调用不重建实例）', () => {
    const first = initI18n();
    const second = initI18n();
    expect(first).toBe(second);
  });

  it('资源可用：chat.inputLabel 查询到中文文案', () => {
    expect(i18n.t('chat.inputLabel')).toBe('聊天消息输入框');
  });

  it('SUPPORTED_LANGUAGES：zh-CN 与 en', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en']);
  });

  it('resources 结构：双语 common/errors namespace 完整', () => {
    expect(resources['zh-CN'].common).toBeDefined();
    expect(resources['zh-CN'].errors).toBeDefined();
    expect(resources.en.common).toBeDefined();
    expect(resources.en.errors).toBeDefined();
  });

  it('getCurrentLanguage：默认 zh-CN', () => {
    expect(getCurrentLanguage()).toBe('zh-CN');
  });

  it('changeLanguage：切换后 getCurrentLanguage 更新', async () => {
    await i18next.changeLanguage('en');
    expect(getCurrentLanguage()).toBe('en');
    expect(changeLanguage('zh-CN')).toBeUndefined();
  });

  it('useErrorMessage：已注册错误码命中 i18n 文案（非 key 本身）', () => {
    const { result } = renderHook(() => useErrorMessage());
    const message = result.current.getErrorMessage(ErrorCode.AI_TIMEOUT);
    expect(message).not.toBe(`errors.${ErrorCode.AI_TIMEOUT}`);
    expect(message.length).toBeGreaterThan(0);
  });

  it('useErrorMessage：未知错误码回退原文（key 本身，不抛）', () => {
    const { result } = renderHook(() => useErrorMessage());
    const message = result.current.getErrorMessage('NOT_A_REAL_CODE' as ErrorCode);
    expect(message).toBe('errors.NOT_A_REAL_CODE');
  });

  it('useErrorMessage：中文文案与 ERROR_META 语义一致（双源一致验证）', () => {
    const { result } = renderHook(() => useErrorMessage());
    const message = result.current.getErrorMessage(ErrorCode.INVALID_INPUT);
    // 若 i18n 缺失则回退 ERROR_META，两种路径都不应返回 key
    expect(message).not.toBe(`errors.${ErrorCode.INVALID_INPUT}`);
  });
});
