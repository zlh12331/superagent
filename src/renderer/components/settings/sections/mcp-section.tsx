// src/renderer/components/settings/sections/mcp-section.tsx
// MCP 服务器管理 pane（对齐参考项目 superagent McpSettingsPane）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 列出已启动的 MCP server（名称 / 状态徽章 / 工具数 / 错误信息）
// - 添加服务器表单（名称 / 命令 / 参数，对齐主进程 McpServerConfig）
// - 启动 / 停止操作（mcp:start / mcp:stop IPC）
// - 数据源：mcp:list（L3 TanStack Query，启动/停止后 invalidate）
// ──────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Square, Wrench } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { SectionTitle, SettingRow } from '../settings-controls';

/** mcp:list 查询 key */
const MCP_LIST_QUERY_KEY = ['mcp', 'servers'] as const;

/** 状态徽章配色（键名与主进程 McpServerStatus 对齐，含 snake_case） */
const STATUS_BADGE: Record<string, string> = {
  running: 'bg-[var(--success)]/10 text-[var(--success)]',
  starting: 'bg-[var(--info-blue)] text-[var(--accent-2)]',
  error: 'bg-[var(--error)]/10 text-[var(--error)]',
  stopped: 'bg-muted text-muted-foreground',
  // biome-ignore lint/style/useNamingConvention: 键名与主进程状态枚举对齐（McpServerStatus 含 snake_case）
  stopped_with_error: 'bg-[var(--amber)]/10 text-[var(--warn)]',
};

/**
 * MCP 服务器管理 pane
 */
export function McpSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 添加表单状态（对齐参考项目 McpSettingsPane 添加行）
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  // L3 查询：服务器列表
  const { data, isLoading } = useQuery({
    queryKey: MCP_LIST_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { servers: [] };
      }
      const response = await window.api.mcp.list({});
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });

  /** 操作后失效列表缓存（重新拉取） */
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: MCP_LIST_QUERY_KEY });
  };

  // 启动 mutation
  const startMutation = useMutation({
    mutationFn: async (config: { name: string; command: string; args?: string[] }) => {
      const response = await window.api.mcp.start({
        name: config.name,
        command: config.command,
        args: config.args ?? undefined,
      });
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      toast.success(t('settings.mcpStarted'));
      setName('');
      setCommand('');
      setArgs('');
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      invalidate();
    },
  });

  // 停止 mutation
  const stopMutation = useMutation({
    mutationFn: async (serverName: string) => {
      const response = await window.api.mcp.stop({ name: serverName });
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      toast.success(t('settings.mcpStopped'));
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      invalidate();
    },
  });

  const servers = data?.servers ?? [];
  // 已展开工具列表的 server 名（对齐参考项目 McpServerDetailDialog 的详情查看）
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('settings.mcpServers')}</SectionTitle>
      <p className="text-muted-foreground text-xs leading-[1.5]">{t('settings.mcpHint')}</p>

      {/* 服务器列表 */}
      {isLoading && <div className="text-muted-foreground text-xs">Loading…</div>}
      {!isLoading && servers.length === 0 && (
        <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
          {t('settings.mcpEmpty')}
        </div>
      )}
      {servers.map((server) => (
        <div key={server.config.name} className="flex flex-col gap-1">
          <SettingRow
            key={server.config.name}
            label={server.config.name}
            description={`${server.config.command} ${(server.config.args ?? []).join(' ')}`}
          >
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 font-mono text-2xs',
                STATUS_BADGE[server.status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {server.status}
            </span>
            {server.toolNames.length > 0 && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-0.5 font-mono text-2xs transition-colors"
                title={server.toolNames.join('\n')}
                onClick={() =>
                  setExpandedServer((prev) =>
                    prev === server.config.name ? null : server.config.name,
                  )
                }
                aria-expanded={expandedServer === server.config.name}
              >
                {expandedServer === server.config.name ? (
                  <ChevronDown className="size-3" strokeWidth={1.5} />
                ) : (
                  <ChevronRight className="size-3" strokeWidth={1.5} />
                )}
                {server.toolNames.length} tools
              </button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="size-7 p-0"
              disabled={stopMutation.isPending}
              onClick={() => stopMutation.mutate(server.config.name)}
              aria-label={t('settings.mcpStop')}
              title={t('settings.mcpStop')}
            >
              <Square className="size-3" />
            </Button>
          </SettingRow>
          {/* 工具列表详情（展开态，对齐参考项目 McpServerDetailDialog） */}
          {expandedServer === server.config.name && (
            <div className="bg-card rounded-lg border px-3 py-2">
              {server.toolNames.length === 0 ? (
                <span className="text-muted-foreground text-xs">{t('settings.mcpNoTools')}</span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {server.toolNames.map((toolName) => (
                    <li
                      key={toolName}
                      className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs"
                    >
                      <Wrench className="size-2.5 shrink-0" strokeWidth={1.5} />
                      <span className="truncate">{toolName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}

      {/* 添加服务器表单 */}
      <SectionTitle>{t('settings.mcpAdd')}</SectionTitle>
      <div className="flex flex-col gap-1.5">
        <Input
          placeholder={t('settings.mcpNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
        <Input
          placeholder={t('settings.mcpCommandPlaceholder')}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          spellCheck={false}
        />
        <Input
          placeholder={t('settings.mcpArgsPlaceholder')}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={startMutation.isPending || name.trim() === '' || command.trim() === ''}
          onClick={() =>
            startMutation.mutate({
              name: name.trim(),
              command: command.trim(),
              ...(args.trim() !== '' ? { args: args.trim().split(/\s+/) } : {}),
            })
          }
        >
          <Plus className="size-3.5" />
          {t('settings.mcpStart')}
        </Button>
      </div>
    </div>
  );
}
