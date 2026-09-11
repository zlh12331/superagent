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
import { unwrap } from '@/lib/ipc';
import { IM_ALLOWED_GROUPS_QUERY_KEY } from '@/lib/query/keys';

/** 群聊执行白名单的 settings key（与主进程 im-allowlist-pref 约定一致） */
export const IM_ALLOWED_GROUPS_SETTING_KEY = 'im.allowedGroups';

/** 读取白名单（浏览器模式无 window.api 时返回空） */
async function fetchAllowedGroups(): Promise<readonly string[]> {
  if (typeof window === 'undefined' || window.api === undefined) {
    return [];
  }
  try {
    const res = unwrap<{ settings: Record<string, unknown> }>(await window.api.settings.getAll({}));
    const raw = res.settings[IM_ALLOWED_GROUPS_SETTING_KEY];
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 写入白名单（覆盖式） */
async function saveAllowedGroups(groups: readonly string[]): Promise<void> {
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
 */
export function ImAllowlistField(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // null 表示「跟随服务端值」（用户尚未编辑）；编辑后为本地草稿
  const [draft, setDraft] = useState<string | null>(null);
  const { data: allowed } = useQuery({
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

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Label className="font-serif text-xs tracking-wide">
        {t('settings.imAllowedGroupsTitle')}
      </Label>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.imAllowedGroupsHint')}</p>
      <Textarea
        value={draft ?? (allowed ?? []).join('\n')}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('settings.imAllowedGroupsPlaceholder')}
        rows={3}
        className="font-mono text-xs"
      />
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => saveMutation.mutate(parseGroups(draft ?? (allowed ?? []).join('\n')))}
          disabled={saveMutation.isPending}
        >
          {t('settings.imAllowedGroupsSave')}
        </Button>
      </div>
    </div>
  );
}
