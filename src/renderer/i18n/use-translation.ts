// src/renderer/i18n/use-translation.ts
// useTranslation hook 扩展 · 类型安全的文案查询
// ──────────────────────────────────────────────────────────────
// 作用：
// - 在 react-i18next 的 useTranslation 基础上提供项目专用的便捷方法
// - getErrorMessage(code) 直接通过 ErrorCode 查询本地化文案
//   （替代过去直接读 ERROR_META.userMessage 的硬编码方式）
//
// 使用方式：
//   import { useTranslation, useErrorMessage } from '@/i18n/use-translation';
//
//   // 普通文案
//   const { t } = useTranslation();
//   t('common.save')  // → "保存" / "Save"
//
//   // 错误码 → 本地化文案
//   const { getErrorMessage } = useErrorMessage();
//   getErrorMessage(ErrorCode.AI_TIMEOUT)  // → "AI 调用超时" / "AI request timeout"
//
// 兜底策略：
// - 优先查 i18n 资源文件（errors namespace）
// - 资源缺失时回退到 shared 包的 ERROR_META[code].userMessage（中文）
// - 这样文案只在 ERROR_META 一处维护，避免双份同步问题
// ──────────────────────────────────────────────────────────────

import type { ErrorCode } from '@novel-writer/shared';
import { ERROR_META } from '@novel-writer/shared';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

// 再导出 react-i18next 的原生 useTranslation，业务方统一从 @/i18n 导入
export { useTranslation };

/**
 * 错误码 → 本地化文案 hook
 *
 * 替代旧的 `ERROR_META[code].userMessage`（中文硬编码）
 * 现在通过 i18n 资源文件查询，支持多语言
 *
 * @example
 * const { getErrorMessage } = useErrorMessage();
 * toast.error(getErrorMessage(ErrorCode.AI_TIMEOUT));
 */
export function useErrorMessage() {
  const { t } = useTranslation('errors');

  const getErrorMessage = useCallback(
    (code: ErrorCode): string => {
      // 错误码本身就是 i18n key（如 'AI_TIMEOUT'）
      // 资源文件结构：errors.errors.AI_TIMEOUT（namespace.errors.code）
      const key = `errors.${code}`;
      const message = t(key);
      // 兜底：如果资源文件缺失 key，i18next 会返回 key 本身
      // 此时回退到 ERROR_META 的中文默认值（DRY：文案只在 shared 一处维护）
      return message === key ? ERROR_META[code].userMessage : message;
    },
    [t],
  );

  return { getErrorMessage };
}
