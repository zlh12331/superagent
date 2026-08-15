// approval-mode-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · ApprovalModeSection 独立面板
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Shield, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useApprovalMode } from '@/hooks/use-approval-mode';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** whitelist:list 查询 key */
const WHITELIST_QUERY_KEY = ['whitelist', 'entries'] as const;

/** tool:list 查询 key */
const TOOLS_QUERY_KEY = ['tool', 'list'] as const;

export function ApprovalModeSection(): ReactElement {
  const { t } = useTranslation();
  const { mode, setMode } = useApprovalMode();
  const queryClient = useQueryClient();
  // 白名单添加表单（对齐原型 whitelist-panel 的 whitelistInput + 添加按钮）
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

  // L3：白名单条目（跨会话持久化）
  const whitelistQuery = useQuery({
    queryKey: WHITELIST_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { entries: [] as Array<{ toolName: string; pattern: string }> };
      }
      const response = await window.api.whitelist.list();
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });

  // L3：工具清单（tool:list，权限配置卡片数据源）
  const toolsQuery = useQuery({
    queryKey: TOOLS_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { tools: [] as Array<{ name: string; permission: 'auto' | 'ask' }> };
      }
      const response = await window.api.tool.list({ permission: undefined });
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });

  const invalidateWhitelist = (): void => {
    void queryClient.invalidateQueries({ queryKey: WHITELIST_QUERY_KEY });
  };

  // 添加白名单 mutation（whitelist:add）
  const addMutation = useMutation({
    mutationFn: async (entry: { toolName: string; pattern: string }) => {
      // 浏览器模式（dev 预览）无 window.api：本地空操作
      if (typeof window === 'undefined' || window.api === undefined) {
        return { ok: true };
      }
      const response = await window.api.whitelist.add(entry);
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      setWlPattern('');
      invalidateWhitelist();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // 移除白名单 mutation（whitelist:remove）
  const removeMutation = useMutation({
    mutationFn: async (entry: { toolName: string; pattern: string }) => {
      // 浏览器模式（dev 预览）无 window.api：本地空操作
      if (typeof window === 'undefined' || window.api === undefined) {
        return { ok: true };
      }
      const response = await window.api.whitelist.remove(entry);
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      invalidateWhitelist();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
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

      {/* 命令白名单（对齐原型 whitelist-panel：增删命令自动放行）
          持久化于主进程 userData/whitelist.json，跨会话生效 */}
      <div className="pt-1">
        <div className="flex items-center gap-2">
          <ListChecks className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <Label className="font-serif text-sm tracking-wide">{t('settings.whitelistTitle')}</Label>
        </div>
        <p className="text-xs text-muted-foreground font-sans">{t('settings.whitelistHint')}</p>
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
                <button
                  type="button"
                  onClick={() => removeMutation.mutate(entry)}
                  className="text-muted-foreground hover:text-[var(--error)] flex cursor-pointer items-center rounded border px-1.5 py-1 text-2xs transition-colors"
                  aria-label={t('settings.whitelistRemove')}
                >
                  <Trash2 className="size-3" />
                </button>
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
              disabled={addMutation.isPending || wlTool.trim() === '' || removeMutation.isPending}
              onClick={() =>
                addMutation.mutate({ toolName: wlTool.trim(), pattern: wlPattern.trim() })
              }
            >
              {t('settings.whitelistAdd')}
            </Button>
          </div>
        </div>
      </div>

      {/* 权限配置文件（对齐原型 perm-profile 卡片：工具权限徽章）
          数据源：tool:list 真实工具注册表（auto 只读自动 / ask 需审批） */}
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
              <span className="bg-[var(--success)]/10 text-[var(--success)] rounded-full px-2 py-0.5 font-mono text-xs">
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
              <span className="bg-[var(--amber)]/10 text-[var(--warn)] rounded-full px-2 py-0.5 font-mono text-xs">
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

/**
 * 用量统计区块：展示全部会话的 token 消耗汇总（总量 / 按模型 / 按日）
 *
 * 数据来源：session:getUsageSummary（token_usage 表聚合）。
 */
