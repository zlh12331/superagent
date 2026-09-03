# 12. 性能规范

> 对齐业界性能最佳实践，基于项目实际工具链（electron-vite + React Compiler + react-arborist 虚拟化）制定门槛。
> 最后同步：2026-09-03

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
| **首载同步体积** | ≤ 3MB | 2026-09-03 新增：统计 index.html 的 script/modulepreload 所列 chunk 合计（Electron 首帧需下载的 JS）。shiki 按需加载后 index 4.4MB → 0.82MB，首载实测 1.7MB；防延迟语言包被误打回主入口 |
| 新增单个 npm 依赖 | ≤ 150KB（gzip） | 引入前用 bundlephobia 级评估；超限需论证（见 §四） |

> **基线策略**：先有基线门槛卡住回退（新引入超限即失败），再渐进收紧。当前状态（2026-09-03）：
> - ~~index chunk 4.4MB（shiki 全量语言 + tree-sitter wasm 主包）~~ → **已解决**：shiki 切到
>   `shiki/bundle/web` + `loadLanguage` 按需注册（`src/renderer/lib/highlight.ts`），
>   index chunk 降至 0.82MB，语言各自成为懒加载异步 chunk，总包降至 10.8MB
> - ~~cpp/emacs-lisp 语言 chunk 超 500KB~~ → 已改为"按需懒 chunk"：仅代码块/文件首次遇到该语言才请求
> - 收紧节奏：每轮重构后对比 `pnpm analyze:bundle`，总包与首载体积下降则同步下调门槛。

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
6. **shiki 语言按需加载（2026-09-03）**：highlighter 单例位于 `src/renderer/lib/highlight.ts`，从
   `shiki/bundle/web`（非 `shiki` bundle-full）创建，只预载 8 个热语言（TS/JS/JSX/TSX/bash/shell/json/python）；
   go/rust/cpp 等 13 种进 `DEFERRED_LANG_MODULES` 显式动态 import 表，`ensureLangLoaded` 首次遇到才
   `loadLanguage`（并发去重）。`normalizeLang` 为纯 canonical 解析（预载 ∪ 延迟表），不因未预载静态降级。
   流式跳过高亮（`highlight` prop）保持；延迟语言首见一次加载后缓存
7. **流式自动滚动（2026-09-03）**：流式期间且用户在底部 → `scrollTop` 瞬时定位（smooth 动画在高频
   chunk 追加下持续滚动重排，是流式抖动主疑点）；用户显式点击"滚动到底部"仍 smooth（一次性意图）
8. **滚动事件合帧（2026-09-03）**：`handleScroll` 的底部按钮显隐/新消息标记/分页加载统一 rAF 合帧
   （对齐导航轨 `scheduleSync`），滚动事件风暴下每帧至多一次状态写入

## 三、长列表虚拟化决策

| 场景 | 方案 | 现状 |
|---|---|---|
| 文件树（数千节点） | **react-arborist 内置虚拟化** | ✅ 已用 |
| 会话列表（侧边栏） | 原生滚动 + 分页（session:list limit） | ✅ 已用 |
| 消息列表 | **分页窗口渲染**（`message-window.ts`）：数据全量留存 useChat messages（LLM 上下文完整），仅裁剪 DOM——默认渲染最近 `MESSAGE_PAGE_SIZE=200` 条，滚动到顶加载更早批次（`nextPageStart` + 高度补偿 `prevScrollHeightRef`）；流式增量自然 append | ✅ 已用（2026-08 落地） |
| diff 大文件 | 折叠默认展开（max-h + overflow） | ✅ 已用 |

**消息列表虚拟化决策（2026-09-03 复审，保持分页窗口，不引入 `@tanstack/react-virtual`）**：

- 分页窗口已达成虚拟化的实际目标：DOM 裁剪到固定 200 条/页（`clampStart` 兜底），实测 300 条长会话容器子树 945 节点，远低于 §4 的 5000 节点基准
- react-virtuoso 已因 React 19 下 data 空→非空的时序 bug 弃用（2026-08 实测）；真虚拟化需重写已调优并被测试覆盖的：滚动到顶加载/`ensureIndexStart` 扩窗定位/导航轨 `message-offsets` 偏移快照/搜索定位/流式智能跟随——收益≈0 且回归风险高
- 数据全量留存 messages 仅裁剪 DOM，对 LLM 上下文与状态管理侵入最小

**升级 @tanstack/react-virtual 的触发指标（任一命中再评估）**：
1. 单页 200 条渲染后 `document.querySelectorAll('*').length` > 8000（在 render.bench 断言）
2. 连续滚动期间 PerformanceObserver longtask > 200ms 非零
3. 会话超 10 万条且滚动/流式跟随掉帧（>16ms 帧预算被击中）
升级时必须重跑：`pnpm test:renderer`（ChatMessageList/message-window 测试）+ `pnpm test:perf`，逐项人工回归导航轨/搜索跳转/流式自动滚动/滚动到顶加载更早。

## 四、性能验证

### 4.1 基准体系（2026-08-11 落地，三层）

| 层 | 命令 | 覆盖 | 关键阈值（基线，渐进收紧） |
|---|---|---|---|
| **主进程基准**（vitest，真实实现） | `pnpm test:perf:main` | SQLite 存储（万级消息/查询/索引命中 EXPLAIN 验证）、ripgrep 搜索（25000 行/500 文件）、node-pty 终端吞吐（2000 行） | 追加 100 条 < 100ms；list(50) < 5ms；get(1000 条) < 100ms；搜索 < 500ms；终端 ≥ 300 行/s |
| **浏览器 E2E 基准**（Playwright + CDP） | `pnpm test:perf` | 首载可交互 < 3000ms、DOM 节点 < 5000、布局引擎 reflow（标注非 React 路径）、滚动、**CDP 真实指标**（Script/Layout 增量）、**长任务观测**（>200ms 阻塞=失败）、heap 三阶段趋势（对齐 memlab 方法论）、IPC mock 链路 RTT | 长任务 >200ms 必须为 0；heap 增长 < 15MB 且无单调增长 |
| **渲染基准新增**（2026-09-03） | `pnpm test:perf`（渲染性能基准组） | 长会话 DOM 规模（真实 ChatMessageList 容器 + 注入 300 条 → 子树节点 < 5000，防虚拟化回归）、滚动交互 3 轮强制 reflow 期间无 >200ms 长任务、首载同步体积（见 §1.2） | DOM < 5000；滚动长任务 >200ms = 0；首载 JS ≤ 3MB |
| **真实 Electron 链路**（playwright Electron 模式） | `pnpm test:perf:electron` | 真实 invoke RTT（median/p95）、500KB 大 payload 往返（file.read 真实链路）、事件推送吞吐（无丢失）、启动分段（仅报告；生产版由 smoke 卡关） | RTT median < 20ms；500KB < 300ms；事件 ≥ 500/s 且零丢失 |

### 4.2 工程化约定

1. **阈值策略**：多轮采样取中位数（抗 GC/系统抖动）+ 宽松基线（防明显回退），随优化渐进收紧
2. **诚实标注**：布局引擎基准（DOM 注入）明确标注非 React 渲染路径；mock 链路基准（浏览器 IPC）明确标注非真实进程通信，真实链路由 Electron 基准覆盖
3. **发现记录**（2026-08-11）：terminal:event:output 全链路渲染路径（store→TerminalPanel/xterm）每事件 ~166ms 为**测试时序误判**（订阅未就绪即 send），已修正为屏障同步；真实 IPC 分发吞吐实测 719 事件/s（受测试分批节奏限制，非上限）
3.5 **发现记录**（2026-09-03）：渲染性能基准此前 `page.goto('/')` 进欢迎页，`chat-message-list` 容器不存在导致 DOM 注入用例全部**静默 no-op**——已改为 `/#/chat/mock-1` 走真实聊天路由 + 前置断言容器可见；实测基线：1000 条 reflow 10.5ms、滚动 7.8ms、300 条长会话 DOM 945 节点
4. `pnpm analyze:bundle` 对比门槛（§1.2）；`pnpm check:bundle` 记录历史趋势到 `stats/bundle-history.json`（环比超 ±15% 告警，不卡关）且新增首载同步体积门槛（>3MB 卡关）
5. `pnpm knip` 死代码卡关
6. 大列表/流式场景手工验证（DevTools Performance 面板，长任务 < 200ms）
7. 内存：长会话连续操作后 heap 不持续增长（订阅泄漏回归，CDP HeapProfiler.collectGarbage 强制 GC）
8. **首载体积**（2026-09-03）：`pnpm build && pnpm check:bundle` 输出"首载同步体积"（index.html script/modulepreload 引用的 chunk 合计），门槛 ≤ 3MB——防延迟语言包被误打回主入口（shiki 按需加载后实测 1.7MB）

### 4.3 深挖工具链（哨兵报警后的定位路径，2026-08-11 落地）

| 层 | 工具 | 用法 |
|---|---|---|
| **渲染层取证** | CDP `HeapProfiler.takeHeapSnapshot`（memory-leak 基准内建） | 基准断言失败自动落盘 `stats/heap-snapshots/*.heapsnapshot` → Chrome DevTools Memory → Load → Retainers 面板看引用链（人工权威分析） |
| **主进程诊断** | `pnpm perf:inspect`（Electron `--inspect=9229`） | Chrome DevTools `chrome://inspect` 连接 → Memory 面板 heap snapshot / Allocation instrumentation；或主进程代码内 `v8.writeHeapSnapshot()` 按需落盘 |
| **生产趋势** | Sentry `captureMessage`（主进程 memory-monitor 内建） | 60s 采样 + 连续 3 次单调增长且累计 > 150MB 告警（防 GC 抖动误报）；遥测 off / DSN 未配置时 no-op |

> **评估记录**：Clinic.js（NearForm，Node 社区标准）实测**不适用**——命令行强制 `node` 前缀（`clinic doctor -- node ...`），无法 profile Electron 主进程；0x 同理需额外验证。Electron 主进程即 Node 环境，官方 `--inspect` + DevTools / `v8.writeHeapSnapshot()` 是零依赖且 100% 可行的正确路径（2026-08-11 实测结论）。
