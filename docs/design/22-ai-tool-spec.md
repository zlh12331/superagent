# 22. AI 工具开发规范

> 基于项目实际工具体系（28 个工具 + tool-executor/registry/permission 支撑层 + scaffold:tool 脚手架）制定。
> 最后同步：2026-08-11

---

## 一、工具命名与文件位置（强制）

| 项 | 规则 | 示例 |
|---|---|---|
| 工具名 | snake_case | `fetch_url`、`run_command` |
| 文件名 | kebab-case + `.tool.ts` | `fetch-url.tool.ts` |
| 位置 | `src/main/infra/ai/tools/` | 注册在 `index.ts`（registerBuiltinTools） |
| 生成 | `pnpm scaffold:tool --name <snake_case> --permission auto\|ask` | 禁止手写骨架 |

## 二、工具定义契约

1. **入参 schema**：必须 zod schema（LLM 生成的入参先验证后执行——TypeScript 规范 §安全）；schema 即 AI SDK tools 的 `inputSchema`
2. **权限分级**（permission-service）：
   - `auto`：无副作用/只读（grep/glob/read-file/list-directory）
   - `ask`：有副作用（write-file/edit-file/run-command/git-push）——运行时审批（Plan/Ask/Auto/YOLO 模式）
   - 危险命令分类：dangerous-commands.ts（不可逆/影响他人——删除/推送/安装）
3. **错误返回**：execute 失败抛 AppError（code + statusCode），不得返回假成功；可预期失败返回结构化结果
4. **执行约束**：路径操作必须过 path-guard（防遍历/工作区边界）；read-tracker 防重复读取

## 三、注册流程

1. `index.ts` registerBuiltinTools 中注册（依赖经参数注入，DI 装配豁免参数上限）
2. 工具类接口：`ITool`（name/description/inputSchema/execute/needsApproval）
3. 审批：ask 工具由 permission-service 决策 → approval:request 推送渲染层

## 四、测试要求（不使用 mock 原则）

- 工具测试 colocation（`*.tool.test.ts`），用真实实现 + DI fake
- 必测：schema 校验失败、权限决策、错误路径、成功路径

## 五、检查清单

- [ ] snake_case 命名 + scaffold 生成
- [ ] zod 入参 schema
- [ ] 权限分级正确（副作用 → ask）
- [ ] 危险操作入 dangerous-commands
- [ ] 路径过 path-guard
- [ ] AppError 错误返回 + 测试覆盖
