# 12. 性能规范

> 对齐业界性能最佳实践，基于项目实际工具链（electron-vite + React Compiler + react-arborist 虚拟化）制定门槛。
> 最后同步：2026-08-11

---
> 🔒 工程化强制：pnpm check:bundle（构建产物门槛，超限卡关）+ pnpm analyze:bundle（体积报告）

## 一、Bundle 体积门槛

### 1.1 工具

- `pnpm analyze:bundle`（`ANALYZE_BUNDLE=1` rollup-plugin-visualizer）产出体积报告到 `stats/`
- `pnpm knip` 死代码/死依赖卡关（CI）

### 1.2 门槛（renderer 主包，gzip 前）

| 指标 | 门槛（基线） | 说明 |
|---|---|---|
| 单个 chunk | ≤ 5MB | 2026-08-11 基线（当前最大 index 4.4MB）；每轮收紧 |
| 渲染层总包（js 总合） | ≤ 16MB | 当前基线 14.5MB（shiki + tree-sitter + xterm 重依赖）；每轮收紧 |
| 新增单个 npm 依赖 | ≤ 150KB（gzip） | 引入前用 bundlephobia 级评估；超限需论证（见 §四） |

> **基线策略**：先有基线门槛卡住回退（新引入超限即失败），再渐进收紧。当前已知债务：
> - index chunk 4.4MB（shiki 全量语言 + tree-sitter wasm 主包）——优化方向：shiki 语言按需注册（`createHighlighter` + 动态语言）、tree-sitter wasm 延迟加载
> - cpp/emacs-lisp 语言 chunk 超 500KB——按需加载后自然消除
> 收紧节奏：每轮重构后对比 `pnpm analyze:bundle`，总包下降则同步下调门槛。

### 1.3 依赖纪律（与 02-tech-stack / UI 架构原则联动）

- **禁全家桶**：不为单组件引入整套库（antd/three/mermaid 等），评估三关：依赖清单 / 设计体系兼容 / Runtime 绑定
- **按需引入**：lucide-react 图标按名导入；Radix 单包按需（8 个独立包）
- **tree-shake 友好**：导入走具名导出，禁止 `import * as` 大库

## 二、渲染优化规则

### 2.1 已启用的机制（不得回退）

- **React Compiler**（oxc-transform-react，`compilationMode: 'infer'`）——自动 memo，禁止用注释/配置绕过；生效性由 `check:compiler` 门禁断言（产物须含 react/compiler-runtime 痕迹）
- **memo 包裹**：高频重渲染组件（MessageItem 等）显式 `memo`
- **动态 import**：路由（router.tsx）与低频面板（DevPanel 等）按需加载（lazy）

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

### 4.1 基准体系（2026-08-11 落地，三层）

| 层 | 命令 | 覆盖 | 关键阈值（基线，渐进收紧） |
|---|---|---|---|
| **主进程基准**（vitest，真实实现） | `pnpm test:perf:main` | SQLite 存储（万级消息/查询/索引命中 EXPLAIN 验证）、ripgrep 搜索（25000 行/500 文件）、node-pty 终端吞吐（2000 行） | 追加 100 条 < 100ms；list(50) < 5ms；get(1000 条) < 100ms；搜索 < 500ms；终端 ≥ 300 行/s |
| **浏览器 E2E 基准**（Playwright + CDP） | `pnpm test:perf` | 首载可交互 < 3000ms、DOM 节点 < 5000、布局引擎 reflow（标注非 React 路径）、滚动、**CDP 真实指标**（Script/Layout 增量）、**长任务观测**（>200ms 阻塞=失败）、heap 三阶段趋势（对齐 memlab 方法论）、IPC mock 链路 RTT | 长任务 >200ms 必须为 0；heap 增长 < 15MB 且无单调增长 |
| **真实 Electron 链路**（playwright Electron 模式） | `pnpm test:perf:electron` | 真实 invoke RTT（median/p95）、500KB 大 payload 往返（file.read 真实链路）、事件推送吞吐（无丢失）、启动分段（仅报告；生产版由 smoke 卡关） | RTT median < 20ms；500KB < 300ms；事件 ≥ 500/s 且零丢失 |

### 4.2 工程化约定

1. **阈值策略**：多轮采样取中位数（抗 GC/系统抖动）+ 宽松基线（防明显回退），随优化渐进收紧
2. **诚实标注**：布局引擎基准（DOM 注入）明确标注非 React 渲染路径；mock 链路基准（浏览器 IPC）明确标注非真实进程通信，真实链路由 Electron 基准覆盖
3. **发现记录**（2026-08-11）：terminal:event:output 全链路渲染路径（store→TerminalPanel/xterm）每事件 ~166ms 为**测试时序误判**（订阅未就绪即 send），已修正为屏障同步；真实 IPC 分发吞吐实测 719 事件/s（受测试分批节奏限制，非上限）
4. `pnpm analyze:bundle` 对比门槛（§1.2）；`pnpm check:bundle` 记录历史趋势到 `stats/bundle-history.json`（环比超 ±15% 告警，不卡关）
5. `pnpm knip` 死代码卡关
6. 大列表/流式场景手工验证（DevTools Performance 面板，长任务 < 200ms）
7. 内存：长会话连续操作后 heap 不持续增长（订阅泄漏回归，CDP HeapProfiler.collectGarbage 强制 GC）

### 4.3 深挖工具链（哨兵报警后的定位路径，2026-08-11 落地）

| 层 | 工具 | 用法 |
|---|---|---|
| **渲染层取证** | CDP `HeapProfiler.takeHeapSnapshot`（memory-leak 基准内建） | 基准断言失败自动落盘 `stats/heap-snapshots/*.heapsnapshot` → Chrome DevTools Memory → Load → Retainers 面板看引用链（人工权威分析） |
| **主进程诊断** | `pnpm perf:inspect`（Electron `--inspect=9229`） | Chrome DevTools `chrome://inspect` 连接 → Memory 面板 heap snapshot / Allocation instrumentation；或主进程代码内 `v8.writeHeapSnapshot()` 按需落盘 |
| **生产趋势** | Sentry `captureMessage`（主进程 memory-monitor 内建） | 60s 采样 + 连续 3 次单调增长且累计 > 150MB 告警（防 GC 抖动误报）；遥测 off / DSN 未配置时 no-op |

> **评估记录**：Clinic.js（NearForm，Node 社区标准）实测**不适用**——命令行强制 `node` 前缀（`clinic doctor -- node ...`），无法 profile Electron 主进程；0x 同理需额外验证。Electron 主进程即 Node 环境，官方 `--inspect` + DevTools / `v8.writeHeapSnapshot()` 是零依赖且 100% 可行的正确路径（2026-08-11 实测结论）。
