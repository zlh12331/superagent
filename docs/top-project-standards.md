# 顶尖项目的八个极致 + 代码质量基线

> 本文档定义本项目（Code Agent Desktop 模板）追求的质量标准框架。
> 工程化决定下限（不出低级错误），体验/性能/可靠性/安全/知识/数据/演进决定上限（用户为什么选择你）。

## 一、八个极致框架

```
⑧ 演进极致（兼容性/升级路径/技术债管理）
⑦ 数据极致（数据资产/备份迁移/隐私合规）
⑥ 知识极致（文档/决策/可发现性）
⑤ 安全极致（纵深防御/供应链/响应）
④ 可靠性极致（韧性/恢复/数据安全）
③ 性能极致（预算化/可度量/有目标）
② 体验极致（UX 细节/a11y/i18n/一致性）
① 工程化极致（门禁/测试/CI/自动化）
```

### ① 工程化极致 —— 已完成度高（近满配）

| 设施 | 状态 |
|---|---|
| 门禁：typecheck / lint / test / knip（CI 卡关） | ✅ |
| 自动化生成：IPC 定义表 / scaffold 脚手架 / changelog 生成器 | ✅ |
| Git 工程：Husky（pre-commit/pre-push）+ commitlint + lint-staged | ✅ |
| 测试：Vitest 三层（539+ 测试，无 mock 规范）+ Playwright 三套配置 | ⚠️ 覆盖率 66% vs 门禁 80%；E2E 待重新设计 |
| 可观测：Sentry + OpenTelemetry + electron-log | ✅ |
| 文档：AGENTS.md（已对齐）/ README / CHANGELOG（自动生成） | ✅ |

### ② 体验极致 —— 部分达成

| 已有 | 差距 |
|---|---|
| 动画（motion）/ 拖拽（dnd-kit）/ 消息虚拟化 / 命令面板 / 文件树导航 | a11y 未全量验证（axe 已配置，E2E 未跑） |
| 空状态 / 加载态 / 错误态 / 脏数据保护 | i18n 只有骨架（i18next 已装，文案大多硬编码中文） |
| token 用量 / 更新提示 / diff 语义统计 | 一致性：设计令牌已用 CSS 变量，组件规范待固化 |

### ③ 性能极致 —— 局部达成

| 已有 | 差距 |
|---|---|
| 消息列表虚拟化 / 大文件分批读取 / 输出截断 / DB 索引 / IPC 清理 | 无性能预算（CI 不卡性能） |
| 包体积分析（analyze:bundle） | 启动时间未测（dev ~2s，打包后未验证） |
| perf/navigation.bench 基准（存在，当前失败） | 内存无监控 / 长会话稳定性未压测 |

### ④ 可靠性极致 —— 部分达成

| 已有 | 差距 |
|---|---|
| error-classifier 错误分类 / Sentry 上报 / 脏数据保护 | 崩溃恢复无（会话中断无恢复流程） |
| 本地 SQLite 天然离线 ✓ | 数据导出/备份无 |
| 会话持久化（SQLite + Drizzle） | 降级提示无（如更新源不可用时的用户告知） |

### ⑤ 安全极致 —— 达成度高

| 已有 | 差距 |
|---|---|
| CSP 多供应商域名 / sender 校验（Electron #17）/ safeStorage（DPAPI） | 代码签名未配置（CSC 变量在，证书无） |
| 路径守卫 / 命令注入防护 / 危险命令拦截 | 漏洞响应流程无（Renovate 未运行，供应链纵深未激活） |
| audit-ci + .nsprc 豁免 | — |

### ⑥ 知识极致 —— 部分达成

| 已有 | 差距 |
|---|---|
| AGENTS.md（AI 协作文档）/ CHANGELOG / TypeDoc 契约文档 | **ADR 无**（架构决策记录，模板使用者的核心资产） |
| 状态管理设计参考文档（docs/state-management-design.txt） | 用户手册无 / 贡献指南无 |

### ⑦ 数据极致 —— 部分达成（Code Agent 尤其关键：会话历史即用户工作资产）

| 已有 | 差距 |
|---|---|
| SQLite 本地化存储（会话/提示词/配置） | **无备份/导出/导入**——重装或换机时会话数据无法迁移 |
| safeStorage 加密 API Key | 无数据清理入口（彻底删除所有数据无一键路径） |
| schema 版本 + migrate（settings store） | 数据目录结构无文档（fork 者不知道数据在哪、格式是什么） |

### ⑧ 演进极致 —— 长期迭代能力

| 已有 | 差距 |
|---|---|
| IPC 定义表驱动（契约集中，改造成本低） | **无向后兼容策略**——v1→v2 时 IPC payload 变更如何平滑（现在直接破坏） |
| settings store 版本迁移 ✓ | 无技术债登记（TODO/FIXME 无清单，重构无节奏） |
| changelog + tag 锚点（版本历史可追溯） | 无 EOL 依赖跟踪（electron 大版本升级路径未演练） |

### 软极致（写进框架但不作为硬标准）

| 维度 | 现状 |
|---|---|
| 可维护性 | Biome complexity 已启用但无阈值卡关（函数复杂度/嵌套深度）；注释规范待固化（"为什么"注释） |
| 反馈闭环 | Sentry 已有崩溃采集，但无错误率趋势意识（发版后看错误量变化）；用户可诊断性待提升（错误信息可操作，非纯技术堆栈） |

## 二、代码质量基线（TypeScript 极致严格模式）

### 配置清单（packages/tsconfig/base.json）

**基础严格（`strict: true` 全套）**

```
strictNullChecks / strictFunctionTypes / strictPropertyInitialization
strictBindCallApply / strictBuiltinIteratorReturn
```

**激进选项（多数生产项目不开的）**

| 选项 | 作用 | 代码中的体现 |
|---|---|---|
| `exactOptionalPropertyTypes` | 可选字段不能显式传 `undefined` | `...(x !== undefined ? { x } : {})` 条件展开 |
| `noUncheckedIndexedAccess` | 索引访问返回 `T \| undefined` | 大量 `?.` + undefined 守卫 |
| `noPropertyAccessFromIndexSignature` | 索引签名必须 `['key']` 访问 | `data.current?.['folder']`、`process.env['X']` |
| `isolatedDeclarations` | 所有导出必须显式标注类型 | 每个函数/变量显式返回类型 |
| `verbatimModuleSyntax` | type-only import 强制分离 | Biome `useImportType` 配合 |
| `noUncheckedSideEffectImports` | 副作用导入检查 | — |

**代码卫生**

```
noUnusedLocals / noUnusedParameters / noImplicitOverride
noFallthroughCasesInSwitch / noImplicitReturns
forceConsistentCasingInFileNames / allowUnreachableCode: false
isolatedModules / resolveJsonModule / useDefineForClassFields
```

**唯一放宽：`skipLibCheck: true`**（跳过 node_modules 类型检查，业界标配，不算妥协）

### 业界对比

```
一般生产项目：  strict + noUnusedLocals + skipLibCheck
严格的项目：    + exactOptionalPropertyTypes + noUncheckedIndexedAccess
本项目：        上面全有 + isolatedDeclarations + verbatimModuleSyntax
                + noPropertyAccessFromIndexSignature + noUncheckedSideEffectImports
```

### 佐证

- 539+ 测试全绿、306 文件 lint 零警告——配置不是摆设，代码真实在这些约束下写出
- 类型安全维度已无压缩空间，是 TypeScript 当前最强约束

## 三、下一步优先级（按价值/成本）

1. **ADR（架构决策记录）**——模板的灵魂：为什么 IPC 用定义表、为什么状态四层、为什么 plan/build。`docs/adr/` 每篇一页：背景/决策/后果。成本低、对模板价值极高
2. **数据资产可迁移**——会话 JSON 导出 + 一键打开数据目录（用户工作资产不锁死在本机）
3. **IPC 向后兼容策略**——payload 变更规范（新增字段必须 optional），模板使用者升级不破坏
4. **体验层闭环**——a11y 全量验证（axe 已配置）+ i18n 文案收口（当前中英混排）
5. **性能预算进 CI**——修好 perf/navigation.bench 后设阈值卡关（如首次交互 <3s）
6. **技术债登记**——docs/TECH_DEBT.md + TODO 巡检节奏
7. **工程化收尾**——coverage 补 service 层测试、E2E 重新设计（浏览器模式为主 + Electron 独立 CI job）
