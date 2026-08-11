# 13. 表单验证规范

> 基于项目实际验证体系（zod 单一真源 + IPC schema + 手写受控表单）制定选型与模式约定。
> 最后同步：2026-08-11

---
> 🔒 工程化强制：IPC schema 由定义表编译期强制（handler 类型缺 schema 即报错）+ ipc/register.ts 运行时统一校验

## 一、选型决策（已定，勿引入新库）

| 库 | 决策 | 理由 |
|---|---|---|
| **zod** | ✅ 采用（IPC schema 单一真源） | 定义表驱动 + 类型推导（`z.infer`），与 IPC 自动化体系同源 |
| **React Hook Form** | ❌ 不引入 | 桌面端表单规模小（设置页/对话框），受控组件 + zod 足够；避免为表单引入重依赖（12-performance §1.3） |
| **手写受控** | ✅ 默认模式 | 组件内 `useState` + `onChange`，React Compiler 自动优化 |

**决策边界**：出现 20+ 字段的大表单（如批量配置导入）或复杂联动校验时，重新评估 React Hook Form（触发条件，不预置）。

## 二、验证分层

```
L1 UI 即时校验      → 组件内（必填/格式提示，无提交等待）
L2 IPC schema 校验  → packages/shared/src/schemas/*（zod，主进程入口强制）
L3 业务校验         → Service 层（跨字段/领域规则）
```

- **L1**：设置页/对话框用受控状态 + 提交前校验；错误就近显示（`aria-invalid` + 描述文本）
- **L2**（强制）：**所有 IPC 入参必须过 zod schema**（定义表 `definitions.ts` 的 schema 即校验器，主进程 `ipc/register.ts` 统一 wrap）；外部输入（LLM 工具入参/文件内容）同样过 zod
- **L3**：跨字段规则（如 git push 的 remote/refspec 组合）在 Service 内校验，错误带 `code` 返回（AppError 体系）

## 三、模式约定

1. **schema 命名**：`packages/shared/src/schemas/<域>.ts`，IPC 请求 schema 与 definitions.ts 对齐（单一真源）
2. **表单状态**：受控 + `useState`；提交中 `disabled` + `Loader2` 防重复提交（已有模式）
3. **错误展示**：
   - 输入框：`aria-invalid` + `border-destructive`（Input 已内置 `aria-invalid:ring-destructive/20`）
   - 行内错误：`text-[var(--error)]` 描述文本（禁止仅 toast）
   - 提交失败：toast.error（sonner）+ 保持表单状态可重试
4. **必填/可选**：Label 语义区分；placeholder 不承担必填提示
5. **空值语义**：字符串空串 = 未填（trim 后校验）；`undefined` vs 空串在 schema 中显式（exactOptionalPropertyTypes 联动）

## 四、检查清单

- [ ] 新 IPC 方法：schema 在 definitions.ts 声明（L2 自动生效）
- [ ] 表单组件：受控 + 提交防重 + 错误就近展示
- [ ] 外部输入（工具调用入参）：zod 验证后才使用（TypeScript 规范 §安全）
- [ ] 错误对象：AppError（code + statusCode），UI 按 code 本地化（i18n errors.json）
