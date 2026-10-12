import type { ErrorCode } from '@code-agent/shared/renderer';
import { ERROR_META } from '@code-agent/shared/renderer';
import { useTranslation } from 'react-i18next';

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

  const getErrorMessage = (code: ErrorCode): string => {
    const key = `errors.${code}`;
    const message = t(key);
    return message === key ? (ERROR_META[code]?.userMessage ?? message) : message;
  };

  return { getErrorMessage };
}
