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
   - ✅ `bg-background` / `text-muted-foreground` / `bg-accent`（令牌已在 `@theme` 注册 `--color-*` 时，优先一等公民语义类；仅未注册令牌（如 `--glass-bg` 表面特效）才用 `bg-[var(--x)]` arbitrary 写法）
   - ❌ `bg-blue-500` / `text-red-600` / `#ff0000`
2. **禁止手动 `dark:` 覆盖**
   - 双主题差异必须用语义令牌表达（`bg-muted` 等令牌两主题自适应）
   - ❌ `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` → ✅ `bg-accent/10 text-accent`
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

## 六、组件状态设计规范

### 6.1 组件分类（决定状态集）

设计状态前先回答「这个组件和用户怎么交互」，按四类确定状态集：

- **展示型**（Badge / Alert / Skeleton）：无用户操作，只需自身语义（如 role="alert"），不硬加交互态。
- **交互型**（Button / Input / Tabs / Switch）：可点击或输入，需要基线五态加 hover / pressed / selected。
- **数据型**（列表 / 详情 / 面板）：含异步数据，需要基线五态加 empty / refreshing（走 AsyncBoundary 五态契约）。
- **复合型**（MessageItem / ToolCallView / Composer）：交互加数据加流程，全量状态外还需流程状态机。

### 6.2 基线五态（每个组件必须）

- **enabled**：基础渲染态，组件存在即必须有。
- **disabled**：禁用态，防止对不可用项操作，disabled:opacity-50 加禁 pointer 事件。
- **focused**：聚焦态，键盘可达性硬性要求，focus-visible 光环。
- **loading**：加载态，含异步数据的组件必须有（否则白屏），骨架屏优先且首载超 200ms 才显示。
- **error**：错误态，可能失败的组件必须有（否则静默失败），错误提示加重试按钮。

### 6.3 状态四要素（每状态写全）

设计每个状态时必须同时定义四要素，缺一不可：视觉（颜色/透明度/图标）、语义（disabled 属性 / aria-* / data-state）、行为（点击无响应 / 不进 Tab 序列 / 重试动作）、过渡（transition 时长与缓动）。

### 6.4 互斥与组合规则

互斥态：loading 与 ready 互斥（五态 discriminated union 保证 TS 穷尽性）；error 与 empty 通常互斥。可组合态：selected 加 hover、selected 加 disabled（如 Tabs 的 data-[state=active]:bg-muted 叠加 disabled:opacity-50）。流程状态机（复合型）：idle 至 running 至 success/error（如 ToolCallView 的 input-streaming 至 input-available 至 output-available 至 output-error）。

### 6.5 实现落点（按状态性质分四层）

纯视觉交互态用 CSS 类（hover:/active:/data-*）；组件内瞬态用 useState/useRef（L1）；跨组件共享用 Zustand（L2，persistent 跨重启/transient 会话内）；服务端数据用 TanStack Query（L3）加 AsyncBoundary 五态。状态变更的数据一致性：服务端状态变更用乐观更新加 invalidate 兑底（禁止依赖 refetch 时序）；组件内状态用函数式 setState（避免闭包旧值）。

### 6.6 ARIA 同步（每视觉状态配语义）

active/selected 配 aria-selected 或 data-state；checked 配 aria-checked；expanded 配 aria-expanded；loading 配 aria-busy 或 role=status；error 即时播报配 role=alert 或 aria-live；动态内容配 aria-live="polite"。禁止只有视觉状态无语义状态。

### 6.7 状态验收检查单

- [ ] 基线五态齐全（enabled/disabled/focused/loading/error）
- [ ] 每状态四要素齐全（视觉+语义+行为+过渡）
- [ ] 组合态有覆盖（selected+hover、selected+disabled）
- [ ] 数据组件走 AsyncBoundary 五态（loading/refreshing/error/empty/ready）
- [ ] 每个视觉状态有对应 ARIA
- [ ] 状态变更数据一致（乐观更新+invalidate 兑底，不依赖 refetch 时序）
- [ ] JSDoc 规格段与实际实现一致（注释声称的状态必须有对应代码）

## 七、新组件开发检查清单

- [ ] 基于 Radix 原语或现有 ui/ 组件组合，不重复造轮子
- [ ] 全部颜色/间距/字体走语义令牌，零硬编码、零 `dark:` 双写
- [ ] `...props` 透传 + `data-slot`；可选时提供受控/非受控双模
- [ ] 复杂交互有键盘导航与 ARIA（Radix 默认覆盖则确认）
- [ ] 定时器/订阅卸载清理；`window.api` 调用有浏览器模式守卫
- [ ] 文档头包含变体/状态/用法示例（见五）
- [ ] 测试 colocation（`__tests__/`，不使用 mock）
- [ ] 门禁：typecheck → lint → test → knip
