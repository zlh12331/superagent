# 上游补丁（patches）

本目录存放**对 vendored 上游源码的改动**（`packages/memory-engine/MemoryCore/`）。

## 为什么需要它

`MemoryCore/` 是第三方源码，直接改会：
- 与上游后续版本产生难以发现的冲突
- 让"上游改了什么"和"我们改了什么"混在一起，无法审计
- 被 `memory-engine:integrity` 拦下（这正是设计目的）

## 用法

1. **改代码**：正常编辑 `MemoryCore/` 下的文件
2. **导出补丁**：`pnpm memory-engine:patch:export <name>` → 生成 `patches/<NNNN>-<name>.patch`
3. **回滚源码**：`pnpm memory-engine:patch:reset` → 把 `MemoryCore/` 恢复到锚点状态
4. **应用补丁**：`pnpm memory-engine:patch:apply` → 重放 `patches/` 下所有补丁（sync 会自动调用）

## 登记（每加一个补丁必须登记）

| 补丁 | 目的 | 影响面 | 上游状态 |
|---|---|---|---|
| （暂无） | — | — | — |

「上游状态」记录：是否已向上游提 issue / PR，以及上游是否已在某版本修复（修复后即可删除本地补丁）。

## 约束

- 补丁按文件名字典序重放（故用 `NNNN-` 前缀保证顺序）
- **补丁打不上 = 同步失败**（对齐上游新版时人工介入），绝不静默跳过
- 补丁不应包含格式化噪音（只改必要的行）
