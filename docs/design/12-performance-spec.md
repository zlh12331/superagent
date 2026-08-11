# 12. 性能规范

> 对齐业界性能最佳实践，基于项目实际工具链（electron-vite + React Compiler + react-arborist 虚拟化）制定门槛。
> 最后同步：2026-08-11

---

## 一、Bundle 体积门槛

### 1.1 工具

- `pnpm analyze:bundle`（`ANALYZE_BUNDLE=1` rollup-plugin-visualizer）产出体积报告到 `stats/`
- `pnpm knip` 死代码/死依赖卡关（CI）

### 1.2 门槛（renderer 主包，gzip 前）

| 指标 | 门槛 | 说明 |
|---|---|---|
| 单个 chunk | ≤ 500KB | 超过必须拆分（动态 import） |
| 渲染层总包（js 总合） | ≤ 1.2MB | 基线参考：shadcn 模式典型增量 20-50KB/组件 |
| 新增单个 npm 依赖 | ≤ 150KB（gzip） | 引入前用 bundlephobia 级评估；超限需论证（见 §四） |

### 1.3 依赖纪律（与 02-tech-stack / UI 架构原则联动）

- **禁全家桶**：不为单组件引入整套库（antd/three/mermaid 等），评估三关：依赖清单 / 设计体系兼容 / Runtime 绑定
- **按需引入**：lucide-react 图标按名导入；Radix 单包按需（8 个独立包）
- **tree-shake 友好**：导入走具名导出，禁止 `import * as` 大库

## 二、渲染优化规则

### 2.1 已启用的机制（不得回退）

- **React Compiler**（babel-plugin-react-compiler）——自动 memo，禁止用注释/配置绕过
- **memo 包裹**：高频重渲染组件（MessageItem 等）显式 `memo`
- **动态 import**：DialogHost/命令面板等低频模块按需加载

### 2.2 规则

1. **zustand selector 稳定性**：selector 返回新数组/对象会触发 useSyncExternalStore 无限循环——必须用 `useMemo` 缓存派生值（教训：TerminalPanel 终端过滤）
2. **流式渲染**：消息流式期间跳过 shiki 高亮（`highlight` prop），结束后再恢复（对齐参考项目）
3. **列表 key**：稳定唯一 key（`type+序号` 等），禁止 index key 于可重排列表
4. **事件订阅清理**：subscribe/定时器卸载必清理，防泄漏（L4 IPC 订阅）
5. **重渲染边界**：子组件 props 用原始值/稳定引用；回调用 `useCallback`（React Compiler 已自动处理时不要重复包裹）

## 三、长列表虚拟化决策

| 场景 | 方案 | 现状 |
|---|---|---|
| 文件树（数千节点） | **react-arborist 内置虚拟化** | ✅ 已用 |
| 会话列表（侧边栏） | 原生滚动 + 分页（session:list limit） | ✅ 已用 |
| 消息列表 | 原生滚动 + 流式增量；**不虚拟化**（消息 DOM 结构复杂且数量有限） | 决策记录：超出 500 条/会话时再评估 react-virtuoso |
| diff 大文件 | 折叠默认展开（max-h + overflow） | ✅ 已用 |

**决策规则**：节点数 > 1000 或渲染成本高的列表才引入虚拟化；引入前必须满足 §1.2 门槛。

## 四、性能验证

1. `pnpm analyze:bundle` 对比门槛（§1.2）
2. `pnpm knip` 死代码卡关
3. E2E perf 基准（`e2e/perf/navigation.bench.spec.ts`）对比基线
4. 大列表/流式场景手工验证（DevTools Performance 面板，长任务 < 200ms）
5. 内存：长会话连续操作后 heap 不持续增长（订阅泄漏回归）
