// im-allowlist-field.tsx（自 im-channels-section 拆分）
// 设置对话框 · IM 群聊执行白名单（2026-09-08 安全修复）
// ──────────────────────────────────────────────
// 背景：IM 入站此前只检查审批模式、不校验发送者，任何能给机器人发消息的人
// （群聊任意成员）都能驱动 agent 执行工具。现策略：私聊默认放行，群聊必须
// 在此显式登记 `渠道:会话ID` 才执行（主进程 im-allowlist-pref.ts 读同一 key）。
//
// 存储：复用 settings 通道（key = 'im.allowedGroups'），不新增 IPC——
// 与设置体系同源，主进程直接读 SQLite。
// ──────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { IM_ALLOWED_GROUPS_QUERY_KEY } from '@/lib/query/keys';

/** 群聊执行白名单的 settings key（与主进程 im-allowlist-pref 约定一致） */
export const IM_ALLOWED_GROUPS_SETTING_KEY = 'im.allowedGroups';

/** 读取白名单（浏览器模式无 window.api 时返回空） */
async function fetchAllowedGroups(): Promise<readonly string[]> {
  if (!hasIpcBridge()) {
    return [];
  }
  // 不吞异常：读取失败必须区分于「真的是空白名单」。此前 catch 后 return []，
  // 使 UI 把失败渲染成空白名单，用户一保存就把服务端已登记的白名单覆盖清空。
  const res = unwrap<{ settings: Record<string, unknown> }>(await window.api.settings.getAll({}));
  const raw = res.settings[IM_ALLOWED_GROUPS_SETTING_KEY];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** 写入白名单（覆盖式） */
async function saveAllowedGroups(groups: readonly string[]): Promise<void> {
  // 守卫与读取路径保持一致（浏览器模式无桥时写库同样无意义）
  if (!hasIpcBridge()) {
    throw new Error('window.api unavailable');
  }
  unwrap(await window.api.settings.set({ key: IM_ALLOWED_GROUPS_SETTING_KEY, value: [...groups] }));
}

/** 多行文本 → 去空行的白名单条目 */
function parseGroups(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 群聊白名单编辑区（每行一条 `渠道:会话ID`）
 *
 * 安全约束（2026-09 审计修复）：写入是**覆盖式**的，故在服务端值未就绪
 * （查询 pending）或读取失败（isError）时必须禁用保存——否则 `allowed` 为
 * undefined 会被当成空白名单，一次保存即清空全部已登记群聊（放行/拦截策略
 * 由此静默翻转）。
 */
export function ImAllowlistField(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // null 表示「跟随服务端值」（用户尚未编辑）；编辑后为本地草稿
  const [draft, setDraft] = useState<string | null>(null);
  const {
    data: allowed,
    isPending,
    isError,
  } = useQuery({
    queryKey: IM_ALLOWED_GROUPS_QUERY_KEY(IM_ALLOWED_GROUPS_SETTING_KEY),
    queryFn: fetchAllowedGroups,
  });
  const saveMutation = useMutation({
    mutationFn: saveAllowedGroups,
    onSuccess: () => {
      toast.success(t('settings.imAllowedGroupsSaved'));
      setDraft(null);
      void queryClient.invalidateQueries({
        queryKey: IM_ALLOWED_GROUPS_QUERY_KEY(IM_ALLOWED_GROUPS_SETTING_KEY),
      });
    },
    onError: () => {
      toast.error(t('settings.imAllowedGroupsFailed'));
    },
  });

  // 编辑器文本（单次求值，供 value 与保存共用，避免两处漂移）
  const text = draft ?? (allowed ?? []).join('\n');
  // 服务端值未就绪/读取失败时禁止写入（防覆盖）
  const saveDisabled = saveMutation.isPending || isPending || isError;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Label className="font-serif text-xs tracking-wide">
        {t('settings.imAllowedGroupsTitle')}
      </Label>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.imAllowedGroupsHint')}</p>
      <Textarea
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('settings.imAllowedGroupsPlaceholder')}
        rows={3}
        className="font-mono text-xs"
        disabled={isPending || isError}
      />
      {isError && (
        <p className="text-error-text text-xs">{t('settings.imAllowedGroupsLoadFailed')}</p>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => saveMutation.mutate(parseGroups(text))}
          disabled={saveDisabled}
        >
          {t('settings.imAllowedGroupsSave')}
        </Button>
      </div>
    </div>
  );
}
