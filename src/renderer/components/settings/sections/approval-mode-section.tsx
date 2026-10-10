import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Shield, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { QueryErrorRow, QueryPendingRow } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { useMutationOnError } from '@/hooks/use-mutation-error';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrapErrorMessage } from '@/lib/ipc';
import { TOOLS_LIST_QUERY_KEY, WHITELIST_ENTRIES_QUERY_KEY } from '@/lib/query/keys';
import {
  addWhitelistEntry,
  listTools,
  listWhitelistEntries,
  removeWhitelistEntry,
} from '@/lib/settings-ops';
import { cn } from '@/lib/utils';
import { confirm } from '@/stores/transient/confirm-dialog-store';

/** 审批模式设置区：模式切换（自动/询问）+ 工具白名单增删 */
export function ApprovalModeSection(): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const { mode, setMode } = useApprovalMode();
  const queryClient = useQueryClient();
  const [wlTool, setWlTool] = useState('run_command');
  const [wlPattern, setWlPattern] = useState('');

  const options = [
    {
      value: 'plan' as const,
      label: t('settings.approvalModePlan'),
      desc: t('settings.approvalModePlanDesc'),
    },
    {
      value: 'ask' as const,
      label: t('settings.approvalModeAsk'),
      desc: t('settings.approvalModeAskDesc'),
    },
    {
      value: 'auto' as const,
      label: t('settings.approvalModeAuto'),
      desc: t('settings.approvalModeAutoDesc'),
    },
    {
      value: 'yolo' as const,
      label: t('settings.approvalModeYolo'),
      desc: t('settings.approvalModeYoloDesc'),
    },
  ];

  const whitelistQuery = useQuery({
    queryKey: WHITELIST_ENTRIES_QUERY_KEY,
    queryFn: listWhitelistEntries,
  });

  const toolsQuery = useQuery({
    queryKey: TOOLS_LIST_QUERY_KEY,
    queryFn: listTools,
  });

  const invalidateWhitelist = (): void => {
    void queryClient.invalidateQueries({ queryKey: WHITELIST_ENTRIES_QUERY_KEY });
  };
  const onError = useMutationOnError();

  const addMutation = useMutation({
    mutationFn: addWhitelistEntry,
    onSuccess: () => {
      setWlPattern('');
      invalidateWhitelist();
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: removeWhitelistEntry,
    onSuccess: () => {
      invalidateWhitelist();
    },
    onError,
  });

  const entries = whitelistQuery.data?.entries ?? [];
  const tools = toolsQuery.data?.tools ?? [];
  const autoTools = tools.filter((tool) => tool.permission === 'auto');
  const askTools = tools.filter((tool) => tool.permission === 'ask');

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <Shield className="text-muted-foreground size-4" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">
          {t('settings.approvalModeSection')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.approvalModeHint')}</p>
      <RadioGroup
        value={mode}
        onValueChange={(v) => void setMode(v as (typeof options)[number]['value'])}
        className="grid gap-1.5"
        aria-label={t('settings.approvalModeSection')}
      >
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`approval-mode-${option.value}`}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded border px-2.5 py-1.5',
              mode === option.value
                ? 'border-border bg-muted'
                : 'border-border hover:border-border',
            )}
          >
            <RadioGroupItem
              value={option.value}
              id={`approval-mode-${option.value}`}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-medium font-sans">
                {option.label}
              </span>
              <span className="block text-xs text-muted-foreground font-sans">{option.desc}</span>
            </span>
          </label>
        ))}
      </RadioGroup>

      <div className="pt-1">
        <div className="flex items-center gap-2">
          <ListChecks className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <Label className="font-serif text-sm tracking-wide">{t('settings.whitelistTitle')}</Label>
        </div>
        <p className="text-xs text-muted-foreground font-sans">{t('settings.whitelistHint')}</p>
        <QueryErrorRow
          isError={whitelistQuery.isError}
          errorMessage={
            whitelistQuery.error instanceof Error
              ? unwrapErrorMessage(whitelistQuery.error, getErrorMessage)
              : null
          }
          onRetry={() => void whitelistQuery.refetch()}
        />
        <QueryPendingRow isPending={whitelistQuery.isPending} />
        <div className="mt-1.5 flex flex-col gap-1.5">
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground font-sans">
              {t('settings.whitelistEmpty')}
            </p>
          ) : (
            entries.map((entry) => (
              <div
                key={`${entry.toolName}:${entry.pattern}`}
                className="flex items-center gap-2 rounded border border-border px-2 py-1.5 font-sans"
              >
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                  {entry.toolName}
                  {entry.pattern !== '' ? (
                    <span className="text-muted-foreground"> · {entry.pattern}</span>
                  ) : (
                    <span className="text-muted-foreground"> · *</span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-error-text size-6 rounded border"
                  aria-label={t('settings.whitelistRemove')}
                  onClick={() => {
                    void confirm({
                      title: t('settings.whitelistRemove'),
                      message: t('common.deleteConfirmDesc'),
                      danger: true,
                    }).then((ok) => {
                      if (ok) removeMutation.mutate(entry);
                    });
                  }}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))
          )}
          <div className="flex gap-1.5">
            <Input
              value={wlTool}
              onChange={(e) => setWlTool(e.target.value)}
              className="w-24 shrink-0 font-mono text-xs"
              spellCheck={false}
              aria-label={t('settings.whitelistToolPlaceholder')}
            />
            <Input
              value={wlPattern}
              onChange={(e) => setWlPattern(e.target.value)}
              className="min-w-0 flex-1 font-mono text-xs"
              placeholder={t('settings.whitelistPatternPlaceholder')}
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 self-stretch"
              disabled={addMutation.isPending || wlTool.trim() === ''}
              onClick={() =>
                addMutation.mutate({ toolName: wlTool.trim(), pattern: wlPattern.trim() })
              }
            >
              {t('settings.whitelistAdd')}
            </Button>
          </div>
        </div>
      </div>

      <div className="pt-1">
        <div className="flex items-center gap-2">
          <ListChecks className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <Label className="font-serif text-sm tracking-wide">
            {t('settings.permProfileTitle')}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground font-sans">{t('settings.permProfileHint')}</p>
        <div className="mt-1.5 grid gap-1.5">
          <div className="rounded border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="text-foreground text-xs font-medium font-sans">
                {t('settings.permAuto')}
              </span>
              <span className="bg-success/10 text-success-text rounded-full px-2 py-0.5 font-mono text-xs">
                auto · {autoTools.length}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs leading-[1.7] text-muted-foreground">
              {autoTools.map((tool) => tool.name).join(' · ') || '—'}
            </p>
          </div>
          <div className="rounded border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="text-foreground text-xs font-medium font-sans">
                {t('settings.permAsk')}
              </span>
              <span className="bg-amber/10 text-warn-text rounded-full px-2 py-0.5 font-mono text-xs">
                ask · {askTools.length}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs leading-[1.7] text-muted-foreground">
              {askTools.map((tool) => tool.name).join(' · ') || '—'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
