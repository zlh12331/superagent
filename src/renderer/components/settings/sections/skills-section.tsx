// src/renderer/components/settings/sections/skills-section.tsx
// 技能管理 pane（对齐参考项目 superagent SkillsSettingsPane）
// ──────────────────────────────────────────────────────────────
// 数据源（skill IPC 三通道，后端已实现）：
// - skill:listLearned：已学技能（DB skills 表，source=learned）
// - skill:learn：输入描述 → LLM 生成结构化技能（learn-skill-agent）
// - skill:removeLearned：移除已学技能
// - skill:list：全部可用技能（内置注册表 + 已学合并）
// ──────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Trash2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { QueryErrorRow } from '@/components/common/AsyncSection';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { SectionTitle, SettingRow } from '../settings-controls';

/** skill:listLearned 查询 key */
const SKILLS_QUERY_KEY = ['skill', 'learned'] as const;

/** 已学技能形状 */
interface LearnedSkill {
  readonly name: string;
  readonly description: string;
}

/**
 * 技能管理 pane
 */
export function SkillsSection(): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 学习表单状态（对齐参考 SkillsSettingsPane 的添加行）
  const [learnPrompt, setLearnPrompt] = useState('');

  // L3：已学技能列表
  const learnedQuery = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { learned: [] as LearnedSkill[] };
      }
      return { learned: unwrap(await window.api.skill.listLearned()) };
    },
  });

  // L3：全部可用技能（内置 + 已学）
  const allSkillsQuery = useQuery({
    queryKey: ['skill', 'all'],
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { skills: [] as LearnedSkill[] };
      }
      return unwrap(await window.api.skill.list());
    },
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['skill', 'all'] });
  };

  // 学习技能 mutation（LLM 生成）
  const learnMutation = useMutation({
    mutationFn: async (rawInput: string) => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { name: '', description: '', prompt: '', replaced: false };
      }
      return unwrap(await window.api.skill.learn({ rawInput }));
    },
    onSuccess: () => {
      toast.success(t('settings.skillLearned'));
      setLearnPrompt('');
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // 移除技能 mutation
  const removeMutation = useMutation({
    mutationFn: async (name: string) => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { removed: true };
      }
      return unwrap(await window.api.skill.removeLearned({ name }));
    },
    onSuccess: () => {
      invalidate();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const learned = learnedQuery.data?.learned ?? [];
  const allSkills = allSkillsQuery.data?.skills ?? [];
  const learnedNames = new Set(learned.map((s) => s.name));
  // 内置技能 = 全部 - 已学
  const builtinSkills = allSkills.filter((s) => !learnedNames.has(s.name));

  return (
    <div className="flex flex-col gap-2">
      {/* 已学技能（LLM 生成，可移除） */}
      <SectionTitle>{t('settings.skillLearnedTitle')}</SectionTitle>
      <p className="text-muted-foreground text-xs leading-[1.5]">
        {t('settings.skillLearnedHint')}
      </p>
      <QueryErrorRow
        isError={learnedQuery.isError}
        errorMessage={learnedQuery.error instanceof Error ? learnedQuery.error.message : null}
        onRetry={() => void learnedQuery.refetch()}
      />
      {learned.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
          {t('settings.skillEmpty')}
        </div>
      ) : (
        learned.map((skill) => (
          <SettingRow key={skill.name} label={skill.name} description={skill.description}>
            <button
              type="button"
              onClick={() => removeMutation.mutate(skill.name)}
              className="text-muted-foreground hover:text-error-text flex cursor-pointer items-center gap-1 rounded border px-1.5 py-1 text-2xs transition-colors"
              aria-label={t('settings.skillRemove')}
            >
              <Trash2 className="size-3" />
            </button>
          </SettingRow>
        ))
      )}

      {/* 学习新技能（LLM 生成） */}
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

      {/* 内置技能（只读展示） */}
      {builtinSkills.length > 0 && (
        <>
          <SectionTitle>{t('settings.skillBuiltinTitle')}</SectionTitle>
          {builtinSkills.map((skill) => (
            <SettingRow key={skill.name} label={skill.name} description={skill.description}>
              <span className="text-muted-foreground/60 font-mono text-[9px]">
                {t('settings.skillBuiltin')}
              </span>
            </SettingRow>
          ))}
        </>
      )}
    </div>
  );
}
