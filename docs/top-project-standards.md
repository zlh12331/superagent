# 顶尖项目的十个极致 + 代码质量基线

> 本文档定义本项目（Code Agent Desktop 模板）追求的质量标准框架。
> 工程化决定下限（不出低级错误），体验/性能/可靠性/安全/知识/数据/演进/架构/生态决定上限（用户为什么选择你）。

## 一、十个极致框架

```
⑩ 协作生态极致（贡献/接力/模板分发）
⑨ 架构极致（结构健康度/复杂度治理/依赖方向）
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

### ⑨ 架构极致 —— 结构健康度（与工程化的区别：工程化管流程，架构管结构）

#### 定义

架构极致 = 系统结构长期保持健康的六个子维度：**依赖方向、循环消除、复杂度治理、模块边界、抽象层次、认知负担**。
工程化保证"过程不犯错"，架构保证"结构不变坏"——两者缺一，长期迭代都会失控。

#### 子维度详解

**1. 依赖方向（单向依赖规则）**

```
依赖必须单向、分层：
  infra/（存储/搜索/终端）← service/（业务编排）← ipc/（适配层）← index（入口）
  shared/ 只能被依赖，不依赖任何上层
规则：上层可依赖下层，下层禁止依赖上层；同层之间不互相依赖
```

- 违反表现：service 直接 import ipc handler、infra 反向依赖 service
- 治理：新代码评审时检查 import 方向；复杂度增长后用 dependency-cruiser 做机器校验

**2. 循环依赖消除**

- 循环依赖是隐性炸弹：模块边界模糊、初始化顺序不确定、测试困难
- 现状：Service Container 用延迟初始化打破服务间循环；IPC 定义表天然单向（meta ← definitions ← channels）
- 差距：**无机器检查**——模块多了以后 import 环靠人工发现太晚
- 目标：引入 dependency-cruiser 或同类工具，CI 卡关（发现环即失败）

**3. 复杂度治理（可度量、有阈值）**

| 指标 | 现状 | 目标阈值 |
|---|---|---|
| 函数复杂度（cyclomatic） | Biome complexity 已启用无阈值 | > 15 卡关 |
| 单函数行数 | 无约束 | > 80 行提示 / > 120 行卡关 |
| 嵌套深度 | 无约束 | > 4 层提示 |
| 单文件行数 | 无约束 | > 400 行提示（提示拆文件，不硬卡） |

- 原则：阈值是护栏不是枷锁——少量合理超限用 biome-ignore 豁免并注明理由

**4. 模块边界（谁可以依赖谁——依赖矩阵）**

```
src/main/
  infra/      → 基础设施（存储/AI/搜索/终端/git/codebase/update）——只能被上层依赖
  telemetry/  → 遥测（Sentry/OTel）——可被任意层依赖（横切关注点）
  security/   → 安全（CSP 等）——main 内部任意层
  ipc/        → 适配层（handler/register）——依赖 infra + utils，不依赖业务编排
  utils/      → 通用工具——禁止依赖任何业务模块
packages/shared/ → 契约层——被所有进程依赖，自身零业务依赖
```

- 差距：边界规则无成文文档（新成员靠 AGENTS.md 和代码注释猜）
- 目标：本节即边界文档；依赖矩阵进 AGENTS.md 架构段

**5. 抽象层次（核心逻辑与细节解耦）**

- 原则：业务逻辑不直接接触细节（如 handler 不直接拼 SQL、service 不直接 spawn 子进程）
- 现状：Service Container 已把服务实例化集中；DI 注入让 handler 不持有实现
- 检查方式：Code Review 时问"这层该知道这个细节吗？"

**6. 认知负担（可读性）**

- 原则：一个文件/函数应该能被新成员一次读懂；名字即文档
- 现状：Biome strictCase 强制命名一致；JSDoc 头注释已成惯例
- 差距：无"可读性巡检"节奏（定期抽查最难读的文件并重构）

#### 架构极致对照

| 已有 | 差距 |
|---|---|
| Service Container 依赖方向清晰 / IPC 定义表单向 / DI 注入解耦 | **无循环依赖检查**（模块增长后 import 环靠人工发现） |
| 分层目录结构稳定 | **复杂度无阈值**（函数复杂度/嵌套深度无卡关） |
| 命名一致性（Biome strictCase）✓ | 模块边界无成文文档（依赖矩阵缺失） |
| — | 可读性巡检无节奏 |

### ⑩ 协作生态极致 —— 模板的终极形态是生态

| 已有 | 差距 |
|---|---|
| commitlint + 分支策略（内部规范）✓ | **无贡献指南**（外部开发者如何提交 PR、跑什么检查） |
| README 有基本说明 ✓ | **无 create 脚手架**（使用者从模板生成新项目要手动复制） |
| — | 无 issue/PR 模板（反馈入口不规范） |

- 对模板的意义：单机模板的价值 = 自己用；**生态模板的价值 = 别人能接力**。贡献指南 + create 脚手架是接力棒

### 软极致（写进框架但不作为硬标准）

| 维度 | 现状 |
|---|---|
| 可维护性 | Biome complexity 已启用但无阈值卡关（函数复杂度/嵌套深度）；注释规范待固化（"为什么"注释） |
| 反馈闭环 | Sentry 已有崩溃采集，但无错误率趋势意识（发版后看错误量变化）；用户可诊断性待提升（错误信息可操作，非纯技术堆栈） |
| 诊断 | 结构化日志 + traceId 贯穿 ✓；但无崩溃现场一键导出（minidump/日志），无健康检查面板（环境/DB/Provider/更新源状态可视化）——Code Agent 用户出问题时应能自诊断 |

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
4. **循环依赖检查进 CI**——dependency-cruiser（发现 import 环即失败），架构极致第一道机器闸
5. **复杂度阈值卡关**——Biome complexity 阈值（函数 >15、嵌套 >4 提示/卡关）
6. **体验层闭环**——a11y 全量验证（axe 已配置）+ i18n 文案收口（当前中英混排）
7. **性能预算进 CI**——修好 perf/navigation.bench 后设阈值卡关（如首次交互 <3s）
8. **技术债登记**——docs/TECH_DEBT.md + TODO 巡检节奏
9. **工程化收尾**——coverage 补 service 层测试、E2E 重新设计（浏览器模式为主 + Electron 独立 CI job）
10. **生态建设**——贡献指南 + issue/PR 模板（推 GitHub 后激活）
