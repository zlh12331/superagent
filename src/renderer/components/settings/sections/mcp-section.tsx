// src/renderer/components/settings/sections/mcp-section.tsx
// MCP 服务器管理 pane（对齐参考项目 superagent McpSettingsPane）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 列出已启动的 MCP server（名称 / 状态徽章 / 工具数 / 错误信息）
// - 添加服务器表单：transport 三态（stdio 本地进程 / sse / streamable-http 远程）
//   · stdio → 命令 + 参数；远程 → URL + 可选请求头（每行 Key: Value）
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
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { SectionTitle, SettingRow } from '../settings-controls';

/** mcp:list 查询 key */
const MCP_LIST_QUERY_KEY = ['mcp', 'servers'] as const;

/** 传输类型三态（与 shared MCP_TRANSPORTS 对齐） */
type McpTransport = 'stdio' | 'sse' | 'streamable-http';

const TRANSPORT_OPTIONS: readonly McpTransport[] = ['stdio', 'sse', 'streamable-http'];

/** 状态徽章配色（键名与主进程 McpServerStatus 对齐，含 snake_case） */
const STATUS_BADGE: Record<string, string> = {
  running: 'bg-success/10 text-success-text',
  starting: 'bg-[var(--info-blue)] text-[var(--accent-2)]',
  error: 'bg-error/10 text-error-text',
  stopped: 'bg-muted text-muted-foreground',
  // biome-ignore lint/style/useNamingConvention: 键名与主进程状态枚举对齐（McpServerStatus 含 snake_case）
  stopped_with_error: 'bg-[var(--amber)]/10 text-warn-text',
};

/**
 * 解析请求头文本为 Record（每行 `Key: Value`；空行忽略）
 *
 * @returns 合法时返回记录与 null；存在无冒号等非法行时返回 null 与首个非法行号
 */
export function parseHeadersText(text: string): {
  headers: Record<string, string> | null;
  invalidLine: number | null;
} {
  const trimmedLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((l) => l.length > 0);
  if (trimmedLines.length === 0) {
    return { headers: {}, invalidLine: null };
  }
  const headers: Record<string, string> = {};
  for (const [index, line] of trimmedLines.entries()) {
    const sepIdx = line.indexOf(':');
    const key = sepIdx > 0 ? line.slice(0, sepIdx).trim() : '';
    const value = sepIdx > 0 ? line.slice(sepIdx + 1).trim() : '';
    if (key.length === 0 || value.length === 0) {
      return { headers: null, invalidLine: index + 1 };
    }
    headers[key] = value;
  }
  return { headers, invalidLine: null };
}

/**
 * MCP 服务器管理 pane
 */
export function McpSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 添加表单状态（transport 三态 + 按 transport 切换字段组）
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [headersText, setHeadersText] = useState('');
  const isRemote = transport !== 'stdio';
  // 请求头实时解析（非法行 → 禁用启动按钮 + 行内错误提示）
  const parsedHeaders = parseHeadersText(headersText);
  const headersInvalid = parsedHeaders.headers === null;

  // L3 查询：服务器列表
  const { data, isLoading } = useQuery({
    queryKey: MCP_LIST_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { servers: [] };
      }
      return unwrap(await window.api.mcp.list({}));
    },
  });

  /** 操作后失效列表缓存（重新拉取） */
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: MCP_LIST_QUERY_KEY });
  };

  // 启动 mutation
  const startMutation = useMutation({
    mutationFn: async (config: {
      name: string;
      transport: McpTransport;
      command: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
    }) => {
      return unwrap(
        await window.api.mcp.start({
          name: config.name,
          ...(config.transport !== 'stdio' ? { transport: config.transport } : {}),
          ...(config.url !== undefined ? { url: config.url } : {}),
          ...(config.headers !== undefined ? { headers: config.headers } : {}),
          command: config.command,
          ...(config.args !== undefined ? { args: config.args } : {}),
        }),
      );
    },
    onSuccess: () => {
      toast.success(t('settings.mcpStarted'));
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      setHeadersText('');
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
      return unwrap(await window.api.mcp.stop({ name: serverName }));
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
      {isLoading && <div className="text-muted-foreground text-xs">{t('common.loading')}</div>}
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
            description={
              server.config.transport !== undefined && server.config.transport !== 'stdio'
                ? (server.config.url ?? '')
                : `${server.config.command ?? ''} ${(server.config.args ?? []).join(' ')}`.trim()
            }
          >
            <span className="text-muted-foreground rounded bg-muted px-1 py-0.5 font-mono text-2xs">
              {server.config.transport ?? 'stdio'}
            </span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 font-mono text-2xs',
                STATUS_BADGE[server.status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {server.status}
            </span>
            {server.toolNames.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-auto gap-0.5 px-0 font-mono text-2xs"
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
              </Button>
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
          {/* 最后一次错误（主进程 lastError 字段，此前仅展示状态徽章、错误信息丢失） */}
          {server.lastError !== undefined && server.lastError !== '' && (
            <p className="text-error-text px-1 font-mono text-2xs break-all" role="status">
              {server.lastError}
            </p>
          )}
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
        {/* 传输类型三态切换（stdio 本地进程 / sse / streamable-http 远程；toggle button 组模式） */}
        <p className="text-muted-foreground text-2xs">{t('settings.mcpTransport')}</p>
        <div className="border-border bg-muted/30 flex w-fit gap-0.5 rounded-md border p-0.5">
          {TRANSPORT_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={transport === option}
              onClick={() => setTransport(option)}
              className={cn(
                'rounded px-2 py-1 font-mono text-2xs transition-colors',
                transport === option
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground cursor-pointer',
              )}
            >
              {option}
            </button>
          ))}
        </div>
        {isRemote ? (
          <>
            <Input
              placeholder={t('settings.mcpUrlPlaceholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              inputMode="url"
            />
            <Input
              placeholder={t('settings.mcpHeadersPlaceholder')}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              spellCheck={false}
            />
            {headersInvalid && (
              <p className="text-error-text px-1 text-2xs" role="status">
                {t('settings.mcpHeadersInvalid', { line: parsedHeaders.invalidLine ?? 1 })}
              </p>
            )}
          </>
        ) : (
          <>
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
          </>
        )}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={
            startMutation.isPending ||
            name.trim() === '' ||
            (isRemote && (url.trim() === '' || headersInvalid)) ||
            (!isRemote && command.trim() === '')
          }
          onClick={() => {
            startMutation.mutate({
              name: name.trim(),
              transport,
              command: isRemote ? '' : command.trim(),
              ...(!isRemote && args.trim() !== '' ? { args: args.trim().split(/\s+/) } : {}),
              ...(isRemote ? { url: url.trim() } : {}),
              ...(isRemote &&
              parsedHeaders.headers !== null &&
              Object.keys(parsedHeaders.headers).length > 0
                ? { headers: parsedHeaders.headers }
                : {}),
            });
          }}
        >
          <Plus className="size-3.5" />
          {t('settings.mcpStart')}
        </Button>
      </div>
    </div>
  );
}
