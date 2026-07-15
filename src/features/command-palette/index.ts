/**
 * Command palette feature — 命令面板
 *
 * 负责全局命令面板（Cmd/Ctrl+K）、模糊搜索、命令执行。
 * 扩展已有命令系统，添加 Codex 业务命令（新建线程、切换线程、
 * 发送 Turn、停止 Turn、打开设置、打开终端等）。
 *
 * 现有组件: src/components/ui/command.tsx（shadcn cmdk 集成）
 * 命令系统: src/lib/commands/（已有注册表模式）
 * 参考源码: prototype.html — 搜索 `command-palette`, `cmdk`
 *
 * 组件扩展: Task 21
 */

export {}
