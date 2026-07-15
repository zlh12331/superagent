/**
 * ApiConfigForm — API 配置表单（生产版本）。
 *
 * 演示 react-hook-form + Zod schema 优先方案的集成模式，作为后续表单开发的参考实现。
 *
 * 架构位置：被 AdvancedPane（生产版本）嵌入渲染，提供 API 接入配置表单。
 * mock 版本中对应 ApiConfigSettingsPane（SettingsPanes.tsx）的「模型接入」区块。
 *
 * 展示 schema 优先方案：
 *  - Zod schema 定义验证规则（URL 格式、最小长度、数字范围）
 *  - TypeScript 类型通过 `z.infer` 从 schema 推断（ApiConfigFormValues）
 *  - `zodResolver` 将 schema 连接到 react-hook-form，自动触发校验
 *  - shadcn/ui Form 组件提供可访问的标签、描述和错误提示
 *  - i18next 提供本地化的字段标签、描述和校验错误消息
 *
 * 字段说明：
 *  - endpoint：API 端点 URL（type=url，Zod 校验 URL 格式）
 *  - apiKey：API 密钥（type=password，Zod 校验最小长度）
 *  - timeoutSeconds：超时秒数（1-300，Zod 校验数字范围）
 *  - retryCount：重试次数（0-10，Zod 校验数字范围）
 *  - debugMode：调试模式开关（Switch）
 *
 * 状态依赖：
 *  - useForm 管理 表单状态（dirty / errors / isSubmitting）
 *  - useMemo 依赖 t 重建 schema，确保语言切换后错误消息本地化
 *
 * 副作用：
 *  - onSubmit：模拟异步保存（setTimeout 800ms），成功 toast.success，失败 toast.error
 *  - 使用 logger 记录保存前后的日志，便于调试
 *
 * @see src/lib/schemas/api-config.ts — Zod schema 定义与默认值
 * @see src/components/preferences/panes/AdvancedPane.tsx — 嵌入此表单的父组件
 */

import { useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { SettingsSection } from '../shared/SettingsComponents'
import {
  createApiConfigSchema,
  apiConfigDefaults,
  type ApiConfigFormValues,
} from '@/lib/schemas/api-config'
import { logger } from '@/lib/logger'

export function ApiConfigForm() {
  const { t } = useTranslation()

  // 使用本地化错误消息创建 schema
  const schema = useMemo(
    () =>
      createApiConfigSchema({
        endpointInvalid: t('preferences.advanced.apiConfig.error.endpoint'),
        apiKeyMin: t('preferences.advanced.apiConfig.error.apiKey'),
        timeoutMin: t('preferences.advanced.apiConfig.error.timeoutMin'),
        timeoutMax: t('preferences.advanced.apiConfig.error.timeoutMax'),
        retryMin: t('preferences.advanced.apiConfig.error.retryMin'),
        retryMax: t('preferences.advanced.apiConfig.error.retryMax'),
      }),
    [t]
  )

  const form = useForm<ApiConfigFormValues>({
    resolver: zodResolver(schema),
    defaultValues: apiConfigDefaults,
  })

  const onSubmit = async (values: ApiConfigFormValues) => {
    try {
      logger.info('Saving API configuration', { endpoint: values.endpoint })
      // 模拟异步保存 — 替换为实际后端调用
      await new Promise(resolve => setTimeout(resolve, 800))
      toast.success(t('preferences.advanced.apiConfig.saveSuccess'))
      logger.info('API configuration saved', values)
    } catch (error) {
      logger.error('Failed to save API configuration', { error })
      toast.error(t('preferences.advanced.apiConfig.saveError'))
    }
  }

  return (
    <SettingsSection title={t('preferences.advanced.apiConfig.title')}>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          <FormField
            control={form.control}
            name="endpoint"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('preferences.advanced.apiConfig.endpoint')}
                </FormLabel>
                <FormControl>
                  <Input
                    type="url"
                    placeholder="https://api.example.com"
                    autoComplete="url"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {t('preferences.advanced.apiConfig.endpointDescription')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="apiKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {t('preferences.advanced.apiConfig.apiKey')}
                </FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    placeholder={t(
                      'preferences.advanced.apiConfig.apiKeyPlaceholder'
                    )}
                    autoComplete="api-key"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {t('preferences.advanced.apiConfig.apiKeyDescription')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="timeoutSeconds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('preferences.advanced.apiConfig.timeout')}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={300}
                      {...field}
                      onChange={e => field.onChange(e.target.valueAsNumber)}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('preferences.advanced.apiConfig.timeoutDescription')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="retryCount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('preferences.advanced.apiConfig.retries')}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      {...field}
                      onChange={e => field.onChange(e.target.valueAsNumber)}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('preferences.advanced.apiConfig.retriesDescription')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="debugMode"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>
                    {t('preferences.advanced.apiConfig.debugMode')}
                  </FormLabel>
                  <FormDescription>
                    {t('preferences.advanced.apiConfig.debugModeDescription')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting
              ? t('preferences.advanced.apiConfig.saving')
              : t('preferences.advanced.apiConfig.save')}
          </Button>
        </form>
      </Form>
    </SettingsSection>
  )
}
