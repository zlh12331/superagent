# 10. 组件设计规范（对齐业界最佳实践）

> 定位：把业界最成熟、最活跃的组件设计规范固化为本项目的组件设计契约。
> 规范来源：Radix UI Primitives（无头组件标准）、shadcn/ui（最活跃的组件分发体系，99.5k+ star）、Headless/Compound Components 模式、社区 58 条 shadcn 最佳实践。
> 适用对象：所有新增/重构的前端组件（components/ui/ 原子组件 + components/{域}/ 业务组件）。

---

## 一、组件设计六大原则（对齐 Radix UI）

| # | 原则 | 含义 | 本项目落地 |
|---|------|------|-----------|
| 1 | **可访问性优先** | 遵循 WAI-ARIA 设计模式：aria/role、焦点管理、键盘导航内置 | 复杂交互组件必须基于 Radix 原语（Dialog/Dropdown/Tabs/Tooltip/AlertDialog 已覆盖） |
| 2 | **无样式核心** | 组件不内嵌样式，样式方案完全自选 | ui/ 组件只含 Tailwind 类，无内联 style；自定义组件用语义令牌 |
| 3 | **开放架构** | 粒度访问每个 part，可包裹并附加事件/props/ref | ui/ 组件全部透传 `...props` + `data-slot`；可被业务组件包裹扩展 |
| 4 | **非受控默认、受控可选** | 默认自管理状态，传入 value/onChange 后切受控 | 参照 ChatInput 双模（internalValue ↔ controlledValue）；复杂状态组件必须双模 |
| 5 | **asChild 渲染控制** | 让使用者完全控制渲染元素 | Button/TooltipTrigger/DropdownMenuTrigger 已用；新组件需要时补齐 |
| 6 | **增量采用** | 按需引入、tree-shakeable | 不引入全家桶组件库（见 02-tech-stack UI 架构原则） |

## 二、样式铁律（对齐 shadcn/ui）

以下规则**强制**，违反即视为设计债：

1. **语义令牌优先，禁止裸色值**
   - ✅ `bg-background` / `text-muted-foreground` / `bg-[var(--accent)]`
   - ❌ `bg-blue-500` / `text-red-600` / `#ff0000`
2. **禁止手动 `dark:` 覆盖**
   - 双主题差异必须用语义令牌表达（`bg-muted` 等令牌两主题自适应）
   - ❌ `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` → ✅ `bg-[var(--accent)]/10 text-[var(--accent)]`
   - 例外：Aurora 令牌未覆盖的琥珀/警告语义可暂用，但须先检查 `--amber`/`--warn`/`--error` 令牌
3. **`className` 只管布局，不管样式**
   - 不改组件颜色/字体；组件内部视觉由组件类与令牌负责
4. **`flex` + `gap-*`，禁止 `space-x-*`/`space-y-*`**
5. **`size-*` 宽高相等时使用，禁止 `w-10 h-10` 双写**（宽高不同维度如 `h-9 w-full` 允许）
6. **条件类统一 `cn()`**（Tailwind Merge 处理冲突）
7. **先内置变体再自定义**：`variant="outline"`/`size="sm"` 优先，禁止调用处随意覆写

## 三、组合模式（对齐 Headless/Compound）

1. **复合组件（Compound Components）**
   - 父组件 Context 隐式共享状态 + 静态属性子组件（`<Tabs.List>`/`<Tabs.Trigger>`）
   - 解决：Prop Drilling、API 膨胀、UI 结构不可控
   - 本项目：Radix 原语已按此模式（Tabs/Dialog/DropdownMenu/Tooltip）；新组合组件照此设计
2. **Render Props / 自定义 Hooks**
   - 需要暴露内部逻辑但不控制展示时，优先提取 hook（如 `useConversationSearch`）
3. **State Reducer 模式**（评估适用）
   - 适用：消费者需要覆盖内部状态转换的复杂交互组件（如自定义 Combobox/Calendar）
   - 不适用：大多数展示型组件；当前项目暂无需求，遇到复杂交互时再引入，禁止预置
4. **提供者模式（Provider）**
   - 跨层级共享配置用 Context Provider（ThemeProvider/QueryProvider/TooltipProvider 已按此模式）

## 四、内部 registry（shadcn 企业实践，可选演进）

- **目标**：跨项目共享内部组件（registry.json schema + CLI 分发）
- **现状**：组件以 copy-paste 模式存在于本仓库（components/ui/），暂未建 registry
- **触发条件**：出现第二个消费方项目 / 组件需要版本管理时，按 shadcn registry-item schema 建立 `@code-agent/ui` 内部 registry
- **组件独立性要求**（为此预留）：每个 ui/ 组件自包含依赖声明（components.json 的 dependencies 字段意识）、不依赖业务代码

## 五、组件文档模板（新增组件必填）

每个新组件在 JSDoc 头或组件目录 README 记录：

```tsx
/**
 * 组件名 —— 一句话职责
 * ──────────────────────────────
 * 变体：variant="default|outline|ghost" / size="sm|md|lg"
 * 状态：受控（value + onValueChange）| 非受控（defaultValue）
 * 依赖：@radix-ui/react-xxx（版本）
 * 用法：
 *   <Component variant="outline" onSelect={...} />
 * 可访问性：基于 Radix 原语（键盘导航/焦点/ARIA 内置）
 * ──────────────────────────────
 */
```

## 六、新组件开发检查清单

- [ ] 基于 Radix 原语或现有 ui/ 组件组合，不重复造轮子
- [ ] 全部颜色/间距/字体走语义令牌，零硬编码、零 `dark:` 双写
- [ ] `...props` 透传 + `data-slot`；可选时提供受控/非受控双模
- [ ] 复杂交互有键盘导航与 ARIA（Radix 默认覆盖则确认）
- [ ] 定时器/订阅卸载清理；`window.api` 调用有浏览器模式守卫
- [ ] 文档头包含变体/状态/用法示例（见五）
- [ ] 测试 colocation（`__tests__/`，不使用 mock）
- [ ] 门禁：typecheck → lint → test → knip
