/**
 * @file 应用偏好（preferences）的 TanStack Query 钩子。
 *
 * 职责：通过 TanStack Query 缓存后端 preferences，提供 usePreferences / useSavePreferences
 *   两个钩子供 App.tsx、PreferencesDialog、use-crash-reporting 等模块共享同一份缓存。
 *
 * 设计要点：
 *  - preferences 是用户跨会话持久化的偏好（主题、语言、Sentry 同意等），属于
 *    服务端持久化数据，应使用 TanStack Query 而非 Zustand；
 *  - savePreferences 成功后通过 setQueryData 立即更新缓存，避免等待重新拉取；
 *  - 加载失败时返回默认值而非抛错，确保应用可在首次启动（无 preferences 文件）时正常工作。
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import i18n from '@/i18n/config'
import { commands, type AppPreferences } from '@/lib/tauri-bindings'

/**
 * preferences 域的 Query Key 工厂。
 *
 * 层级结构便于按范围失效，目前仅有一层 all/preferences。
 */
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: () => [...preferencesQueryKeys.all] as const,
}

/**
 * 加载应用偏好的 TanStack Query 钩子。
 *
 * 错误处理策略：后端返回 error（如首次启动文件不存在）时不抛错，
 *   而是返回包含默认 theme='system' 的默认偏好对象，确保 UI 不至于空白。
 *
 * @returns UseQueryResult<AppPreferences>，data 始终有值（默认或后端返回）
 */
export function usePreferences() {
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(),
    queryFn: async (): Promise<AppPreferences> => {
      logger.debug('Loading preferences from backend')
      const result = await commands.loadPreferences()

      if (result.status === 'error') {
        // 如果 preferences 文件尚不存在，返回默认值
        logger.warn('Failed to load preferences, using defaults', {
          error: result.error,
        })
        return {
          theme: 'system',
          quick_pane_shortcut: null,
          language: null,
          crash_reporting_consent: null,
        }
      }

      logger.info('Preferences loaded successfully', {
        preferences: result.data,
      })
      return result.data
    },
    staleTime: 1000 * 60 * 5, // 5 分钟内不重新请求
    gcTime: 1000 * 60 * 10, // 10 分钟后回收未使用的缓存
  })
}

/**
 * 保存应用偏好的 TanStack Query mutation 钩子。
 *
 * 步骤：
 *  1. 调用后端 savePreferences 命令；
 *  2. 成功后通过 setQueryData 即时更新缓存，避免等待重新拉取的延迟；
 *  3. 弹出成功 toast 提示用户。
 *
 * 错误处理：失败时抛错并弹出 toast，调用方可通过 mutateAsync 捕获。
 *
 * @returns useMutation 实例，mutateAsync 接收 AppPreferences
 */
export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preferences: AppPreferences) => {
      logger.debug('Saving preferences to backend', { preferences })
      const result = await commands.savePreferences(preferences)

      if (result.status === 'error') {
        logger.error('Failed to save preferences', {
          error: result.error,
          preferences,
        })
        toast.error(i18n.t('toast.error.preferencesSaveFailed'), {
          description: result.error.message,
        })
        throw new Error(result.error.message)
      }

      logger.info('Preferences saved successfully')
    },
    onSuccess: (_, preferences) => {
      // 用新的 preferences 更新缓存
      queryClient.setQueryData(preferencesQueryKeys.preferences(), preferences)
      logger.info('Preferences cache updated')
      toast.success(i18n.t('toast.success.preferencesSaved'))
    },
  })
}
