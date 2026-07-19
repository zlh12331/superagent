// src/renderer/hooks/use-characters.ts
// 人物领域 hooks（CRUD + 关系图）
// 设计文档 §5.1 数据流 + §6.2 Character 模型 + §6.3 AGE 关系
//
// 职责：
// - useCharacterList：按 projectId 获取人物列表
// - useCreateCharacter：新建人物
// - useUpdateCharacter：更新人物
// - useDeleteCharacter：删除人物
// - useCharacterRelations：获取人物关系图边
// - useAddCharacterRelation：添加人物关系

import type {
  Character,
  CharacterCreateInput,
  CharacterRelationInput,
  CharacterUpdateInput,
} from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/** 关系查询的临时 queryKey（query-keys 中未定义，避免污染） */
const CHARACTER_RELATIONS_KEY = (projectId: string) =>
  ['characters', 'relations', projectId] as const;

/**
 * 获取人物列表
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useCharacterList(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.characters.list(safeId),
    queryFn: async () => unwrap<Character[]>(await apiClient.character.list({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 新建人物
 *
 * 成功后失效人物列表缓存。
 */
export function useCreateCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CharacterCreateInput) =>
      unwrap<Character>(await apiClient.character.create(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.characters.list(data.projectId) });
    },
  });
}

/**
 * 更新人物
 *
 * 成功后失效人物列表与该人物详情缓存。
 */
export function useUpdateCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CharacterUpdateInput) =>
      unwrap<Character>(await apiClient.character.update(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.characters.list(data.projectId) });
    },
  });
}

/**
 * 删除人物
 *
 * 成功后失效人物列表与关系图缓存。
 */
export function useDeleteCharacter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap<{ id: string }>(await apiClient.character.delete({ id })),
    onSuccess: (_data, _vars, _ctx) => {
      // 简化处理：失效所有 characters 缓存（包含列表与关系）
      void qc.invalidateQueries({ queryKey: queryKeys.characters.all });
    },
  });
}

/**
 * 获取人物关系图边
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useCharacterRelations(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: CHARACTER_RELATIONS_KEY(safeId),
    queryFn: async () =>
      unwrap<CharacterRelationInput[]>(
        await apiClient.character.getRelations({ projectId: safeId }),
      ),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 添加人物关系（图边）
 *
 * 成功后失效关系图缓存。
 */
export function useAddCharacterRelation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CharacterRelationInput) =>
      unwrap<CharacterRelationInput>(await apiClient.character.addRelation(input)),
    onSuccess: () => {
      // 简化处理：失效所有关系缓存（无法从 input 直接拿 projectId）
      void qc.invalidateQueries({
        queryKey: ['characters', 'relations'],
      });
    },
  });
}
