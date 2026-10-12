import type { ComponentProps } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

type TerminalProps = ComponentProps<'span'> & {
  /** 提示符字符（默认 '>'） */
  prompt?: string;
};

/**
 * 终端风格加载指示器（光标闪烁动画）
 *
 * @param className 附加类名（颜色经 currentColor 继承，如 text-muted-foreground）
 * @param prompt 提示符字符，默认 '>'
 */
function Terminal({ className, prompt = '>', ...props }: TerminalProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className={cn('inline-flex items-center gap-[0.25em] font-mono', className)}
      {...props}
    >
      <span aria-hidden="true">{prompt}</span>
      <span aria-hidden="true" className="loading-ui-terminal-cursor" />
      <span className="sr-only">{t('common.loading')}</span>
    </span>
  );
}

export { Terminal };
