/**
 * @file 命令注册中心（Command Registry）。
 *
 * 职责：
 *  - 维护全局命令 Map（key 为 commandId）；
 *  - 提供注册（registerCommands）、查询（getAllCommands）、执行（executeCommand）能力。
 *
 * 设计要点：
 *  - 使用 Map 而非对象，避免原型链属性污染和键序问题；
 *  - executeCommand 内部捕获异常转为结构化错误，调用方不必 try/catch；
 *  - getAllCommands 在搜索时支持 i18n 翻译后的标签匹配。
 */

import type { TFunction } from 'i18next'
import type { AppCommand, CommandContext } from './types'

/** 全局命令注册表，按 commandId 索引。 */
const commandRegistry = new Map<string, AppCommand>()

/**
 * 批量注册命令到全局注册表。
 *
 * 后注册的同名命令会覆盖先前的，便于在不同环境下注入 mock 实现。
 *
 * @param commands 待注册的命令数组
 */
export function registerCommands(commands: AppCommand[]): void {
  commands.forEach(cmd => commandRegistry.set(cmd.id, cmd))
}

/**
 * 获取当前可用的所有命令（已通过 isAvailable 过滤），并按可选搜索词匹配。
 *
 * 步骤：
 *  1. 通过 isAvailable(context) 过滤当前上下文不可用的命令；
 *  2. 若提供 searchValue 与 t，则使用翻译后的 label/description 做大小写不敏感的子串匹配；
 *  3. 否则返回全部可用命令。
 *
 * @param context 当前命令上下文，用于 isAvailable 判断
 * @param searchValue 搜索关键词（可选）
 * @param t i18n 翻译函数（可选，搜索时必需）
 * @returns 命令数组
 */
export function getAllCommands(
  context: CommandContext,
  searchValue = '',
  t?: TFunction
): AppCommand[] {
  const allCommands = Array.from(commandRegistry.values()).filter(
    command => !command.isAvailable || command.isAvailable(context)
  )

  if (searchValue.trim() && t) {
    const search = searchValue.toLowerCase()
    return allCommands.filter(cmd => {
      const label = t(cmd.labelKey).toLowerCase()
      const description = cmd.descriptionKey
        ? t(cmd.descriptionKey).toLowerCase()
        : ''
      return label.includes(search) || description.includes(search)
    })
  }

  return allCommands
}

/**
 * 执行指定 ID 的命令。
 *
 * 内部捕获所有同步与异步异常，返回结构化结果，避免调用方包 try/catch。
 * 步骤：
 *  1. 在注册表中查找命令，未找到返回 not found 错误；
 *  2. 检查 isAvailable，不可用返回 not available 错误；
 *  3. 执行命令并返回 success；
 *  4. 任何抛出的异常都转为 error 字段返回。
 *
 * @param commandId 命令唯一 ID
 * @param context 命令上下文
 * @returns { success, error? } 结构化结果
 */
export async function executeCommand(
  commandId: string,
  context: CommandContext
): Promise<{ success: boolean; error?: string }> {
  try {
    const command = commandRegistry.get(commandId)

    if (!command) {
      return {
        success: false,
        error: `Command '${commandId}' not found`,
      }
    }

    if (command.isAvailable && !command.isAvailable(context)) {
      return {
        success: false,
        error: `Command '${commandId}' is not available`,
      }
    }

    await command.execute(context)

    return { success: true }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error'

    return {
      success: false,
      error: `Failed to execute command '${commandId}': ${errorMessage}`,
    }
  }
}
