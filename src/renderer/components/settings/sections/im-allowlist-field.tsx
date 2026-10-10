import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';
import { IM_ALLOWED_GROUPS_QUERY_KEY } from '@/lib/query/keys';
import {
  fetchImAllowedGroups,
  IM_ALLOWED_GROUPS_SETTING_KEY,
  saveImAllowedGroups,
} from '@/lib/settings-ops';

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
  const [draft, setDraft] = useState<string | null>(null);
  const {
    data: allowed,
    isPending,
    isError,
  } = useQuery({
    queryKey: IM_ALLOWED_GROUPS_QUERY_KEY(IM_ALLOWED_GROUPS_SETTING_KEY),
    queryFn: fetchImAllowedGroups,
  });
  const saveMutation = useMutation({
    mutationFn: saveImAllowedGroups,
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

  const text = draft ?? (allowed ?? []).join('\n');
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
