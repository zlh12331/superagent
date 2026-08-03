# 技术债登记（TECH_DEBT）

> 维护约定：新增技术债时在此登记；重构完成后移除此条目并更新 `top-project-standards.md` 对应状态。
> 巡检节奏：每季度抽查本表最优先项，纳入迭代计划。

## 认知复杂度超限（noExcessiveCognitiveComplexity，阈值 20）

> 架构极致·阶段 2 开启阈值时发现并豁免的存量函数（biome-ignore 已注明理由）。
> 新代码超限会被 lint 卡关，以下为存量债务，按优先级分批重构。

| 优先级 | 文件 | 复杂度 | 说明 |
|---|---|---|---|
| 🔴 P0 | `src/main/infra/ai/agent-service.ts` | 65 | Agent 主循环（工具调用/流式/中断/错误分支）——重构收益最大，风险最高 |
| 🔴 P0 | `src/main/infra/ai/tool-executor.ts` | 37 | 工具执行器（执行/审批/重试/权限分支） |
| 🔴 P0 | `src/main/infra/ai/chat-service.ts` | 33 | Chat 流式循环（增量/完成/错误/中断分支） |
| 🟡 P1 | `src/main/infra/git/git-service.ts` | 31 | Git 操作聚合（多命令/错误分支） |
| 🟡 P1 | `src/renderer/components/agent/ApprovalDialog.tsx` | 25 | 审批对话框 Git 预览（类型分支/预览/确认流） |
| 🟡 P1 | `src/renderer/hooks/use-tool-bridge.ts` | — | 工具桥接（事件订阅/状态分支） |
| 🟢 P2 | `src/main/infra/ai/tools/run-command.tool.ts` | 22 | 命令执行工具（参数/超时/安全校验分支） |
| 🟢 P2 | `src/main/infra/ai/tools/edit-file.tool.ts` | 21 | 编辑文件工具（diff/回退/校验分支） |
| 🟢 P2 | `src/renderer/components/file-tree/FileTreeNode.tsx` | — | 文件树节点（类型/编辑态/展开分支） |
| 🟢 P2 | `src/renderer/components/file-tree/FileViewerDialog.tsx` | — | 文件查看器（模式/脏数据/加载分支） |
| 🟢 P2 | `src/renderer/components/settings/SettingsDialog.tsx` | — | API Key 配置区（编辑/配置/加载分支） |

**重构优先级逻辑**：P0 是核心 AI 编排（复杂度最高、用户价值最大，但需配测试后动手）；P1 是高频 UI/桥接；P2 是轻微超限与低风险组件（可随日常迭代顺手拆）。

## 其他登记项

（待补充：TODO/FIXME 巡检、EOL 依赖、架构债务等）
