/**
 * @file 命令式对话框模块公共导出
 *
 * 对外暴露：
 *  - DialogHost 组件（挂载在应用根节点一次）
 *  - confirm / prompt 便捷函数（调用方使用）
 *  - ConfirmOptions / PromptOptions 类型（调用方构造参数时使用）
 */

export { DialogHost } from './DialogHost'
export {
  confirm,
  prompt,
  type ConfirmOptions,
  type PromptOptions,
} from '@/store/confirm-dialog-store'
