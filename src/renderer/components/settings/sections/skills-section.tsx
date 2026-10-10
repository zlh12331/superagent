import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorRow, QueryPendingRow } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useMutationOnError } from '@/hooks/use-mutation-error';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrapErrorMessage } from '@/lib/ipc';
import { ALL_SKILLS_QUERY_KEY, LEARNED_SKILLS_QUERY_KEY } from '@/lib/query/keys';
import {
  type LearnedSkillInfo,
  learnSkill,
  listLearnedSkills,
  listSkills,
  removeLearnedSkill,
} from '@/lib/settings-ops';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { SectionTitle, SettingRow } from '../settings-controls';

/** 技能管理 pane */
export function SkillsSection(): ReactElement {
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const queryClient = useQueryClient();
  const [learnPrompt, setLearnPrompt] = useState('');

  const learnedQuery = useQuery({
    queryKey: LEARNED_SKILLS_QUERY_KEY,
    queryFn: async () => {
      return { learned: await listLearnedSkills() };
    },
  });

  const allSkillsQuery = useQuery({
    queryKey: ALL_SKILLS_QUERY_KEY,
    queryFn: listSkills,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: LEARNED_SKILLS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ALL_SKILLS_QUERY_KEY });
  };
  const onError = useMutationOnError();

  const learnMutation = useMutation({
    mutationFn: learnSkill,
    onSuccess: () => {
      toast.success(t('settings.skillLearned'));
      setLearnPrompt('');
      invalidate();
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: removeLearnedSkill,
    onSuccess: () => {
      invalidate();
    },
    onError,
  });

  const learned: readonly LearnedSkillInfo[] = learnedQuery.data?.learned ?? [];
  const allSkills = allSkillsQuery.data?.skills ?? [];
  const learnedNames = new Set(learned.map((s) => s.name));
  const builtinSkills = allSkills.filter((s) => !learnedNames.has(s.name));

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('settings.skillLearnedTitle')}</SectionTitle>
      <p className="text-muted-foreground text-xs leading-[1.5]">
        {t('settings.skillLearnedHint')}
      </p>
      <QueryErrorRow
        isError={learnedQuery.isError}
        errorMessage={
          learnedQuery.error instanceof Error
            ? unwrapErrorMessage(learnedQuery.error, getErrorMessage)
            : null
        }
        onRetry={() => void learnedQuery.refetch()}
      />
      <QueryPendingRow isPending={learnedQuery.isPending} />
      {learned.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
          {t('settings.skillEmpty')}
        </div>
      ) : (
        learned.map((skill) => (
          <SettingRow key={skill.name} label={skill.name} description={skill.description}>
            <Button
              variant="outline"
              size="icon"
              className="text-muted-foreground hover:text-error-text size-6"
              aria-label={t('settings.skillRemove')}
              onClick={() => {
                void confirm({
                  title: t('settings.skillRemove'),
                  message: t('settings.skillRemoveConfirmDesc', { name: skill.name }),
                  danger: true,
                }).then((ok) => {
                  if (ok) removeMutation.mutate(skill.name);
                });
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </SettingRow>
        ))
      )}

      <SectionTitle>{t('settings.skillLearn')}</SectionTitle>
      <div className="flex flex-col gap-1.5">
        <Textarea
          placeholder={t('settings.skillLearnPlaceholder')}
          value={learnPrompt}
          onChange={(e) => setLearnPrompt(e.target.value)}
          rows={3}
        />
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={learnMutation.isPending || learnPrompt.trim() === ''}
          onClick={() => learnMutation.mutate(learnPrompt.trim())}
        >
          <Sparkles className="size-3.5" />
          {t('settings.skillLearn')}
        </Button>
      </div>

      {builtinSkills.length > 0 && (
        <>
          <SectionTitle>{t('settings.skillBuiltinTitle')}</SectionTitle>
          {builtinSkills.map((skill) => (
            <SettingRow key={skill.name} label={skill.name} description={skill.description}>
              <span className="text-muted-foreground/60 font-mono text-2xs">
                {t('settings.skillBuiltin')}
              </span>
            </SettingRow>
          ))}
        </>
      )}
    </div>
  );
}
