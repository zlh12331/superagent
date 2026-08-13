# Electron 桌面应用工程化深度审查报告（F:\\TraeProjects\\1）

审查方法：读取 package.json / electron.vite.config.ts / electron-builder.yml / drizzle.config.ts / schema.ts / db.ts / schema-sql.ts / 6 个自研检查脚本 / .github/workflows（ci+release）/ 3 个 Playwright 配置 / biome.json / knip.json / vitest 配置 / husky 钩子，并用 pwsh 实测 node_modules 包体积、git 追踪状态、ripgrep 运行时行为、lockfile 版本。未运行 build/test。

---

## 1.【Critical】【数据层】迁移体系整体缺失：schema 三源真相 + 启动期字符串匹配 ALTER
- **证据**：drizzle/ 目录为空（glob 0 个文件，git ls-files drizzle = 0，drizzle.config.ts:18-27 配置了 out 却从未生成过迁移）；src/main/infra/storage/db.ts:150 直接 sqlite.exec(SCHEMA_SQL) 建表；db.ts:156/168/177 三段 ALTER TABLE sessions ADD COLUMN，靠 err.message.includes('duplicate column name') 字符串匹配判定幂等；schema.ts:77 注释声称 drizzle-orm/sqlite-core 不直接支持复合索引声明（**事实错误**，drizzle 标准 API 支持表级 index().on()，复合索引只存在于裸 SQL 里）；schema.ts:377 用 void sql; 压制未使用导入；schema-sql.ts 头部自称杜绝双源真相，实际制造了与 schema.ts 平行的第二份真相。
- **问题**：加一列要同时改 3 处（schema.ts + schema-sql.ts + db.ts 的 ALTER），任何一处遗漏 = 老用户库启动即崩或列缺失；无 PRAGMA user_version、无迁移版本链、无回滚路径；索引完全游离在 ORM 之外，类型检查无法发现 SCHEMA_SQL 与 schema.ts 漂移（当前两表靠人工保持同步，已有 working_dir/pinned/last_run_status 三次补丁式迁移为证）；drizzle-kit 的 generate/push/migrate 从未接入任何脚本/CI。
- **方向**：启用 drizzle-kit 生成版本化迁移并入库；schema.ts 为唯一真相（用 ORM 声明索引），SCHEMA_SQL 降级为测试夹具或直接删除；启动期只跑 migrate；移除错误字符串匹配的 ALTER 逻辑。

## 2.【High】【依赖】包体积门槛盲区：check:bundle 只测 renderer，主进程运行时依赖无任何监控
- **证据**：check-bundle.ts:6-8 ASSETS_DIR = out/renderer/assets，门槛只覆盖渲染层 chunk（≤5MB/总≤16MB）；pwsh 实测 node_modules：tree-sitter-wasms **49.4MB/39 文件**（36 个 .wasm 语法，code-analyzer.ts:39-54 的 EXT_TO_LANG 只映射 9 种语言，全部打包进 asar）、gpt-tokenizer **50.6MB/1348 文件**（context-compression.ts:24 import { encode } from 'gpt-tokenizer' 根入口导入 = 加载全部模型词表，仅用于 llm-client.ts:236 一次 token 估算）、@larksuiteoapi/node-sdk **28.3MB**（feishu-stream.ts:36 顶层 import * as lark 静态引入，仅用一个长连接 WSClient）、@modelcontextprotocol/sdk 4.1MB/693 文件（mcp/ 下仅 client 侧使用，server 实现全部随包）、better-sqlite3 70.5MB + node-pty 127.8MB（多平台预编译）。
- **问题**：单 tree-sitter-wasms+gpt-tokenizer 就约 100MB 进入安装包；pnpm analyze:bundle / check:bundle 给出 14.5MB 总包的假安全感，完全测不到主进程依赖权重；这是体积门槛设计上的系统性盲区。
- **方向**：check:bundle 增加 main 依赖体积基线（如 asar 内 node_modules ≤N MB）；tree-sitter-wasms 只拷用到的 9 个 wasm 到 resources、gpt-tokenizer 改子路径导入单一编码（cl100k_base 类入口）；@larksuiteoapi 改动态 import + 仅在配置了飞书通道时加载。

## 3.【High】【CI/发布】smoke.prod.spec.ts 硬编码 Windows 路径，却被接入 Linux/macOS 流水线，必挂
- **证据**：e2e/smoke.prod.spec.ts:16-19 EXECUTABLE_PATH = release/win-unpacked/Code Agent Desktop.exe（Windows-only）；ci.yml smoke-prod job 矩阵 os: [windows-latest, ubuntu-latest] 且 Linux 跑 pnpm build:linux（产出 AppImage，无 win-unpacked）后执行 pnpm test:smoke；release.yml build job 三平台矩阵（macOS 产出 release/mac-arm64）都在打包后执行 pnpm test:smoke。
- **问题**：Linux/macOS 上每个测试用例的 launchPackagedApp 都会因可执行文件不存在而抛错 → CI 的 Linux smoke job 与 release 的 mac/Linux 两条腿必然红；该错误会被当成平台特有失败长期忽略，反而掩盖真实回归。
- **方向**：smoke spec 按平台解析可执行文件（win-unpacked/*.exe、linux-unpacked/code-agent-desktop、mac/*.app/Contents/MacOS/*）；或 release.yml 只在 Windows leg 跑 smoke，mac/Linux 由 CI package job 覆盖。

## 4.【High】【CI/发布】Sentry 符号上传步骤恒被跳过 + release 名硬编码，遥测链路形同虚设
- **证据**：release.yml Upload Sentry symbols 步骤 if: env.SENTRY_AUTH_TOKEN != ''，而该 token 只在同一步骤的 env 中注入——GitHub Actions 中步骤级 env 对自身 if 不可见（且 secrets 本就不能进 if 条件），条件恒为 '' != '' = false → 步骤永不执行；注释声称仅 Windows 主发布端但步骤位于三平台共享矩阵（若修复会跑 3 次）；package.json sentry:upload:symbols 硬编码 --release code-agent@1.0.0（版本号不会随 tag 演进）；sentry:release:new 只在本地脚本 build:win:full 里，CI 从未创建 release。
- **问题**：即使修好 if，也会出现上传了符号但 release 名永远是 1.0.0、且 release 未预先创建的次生问题；当前效果是 Sentry 符号上传在发布流水线里完全没跑，崩溃堆栈无法符号化。
- **方向**：用 if: ${{ secrets.SENTRY_AUTH_TOKEN != '' }} 在 job 级判断（secrets 上下文在 if 中可见），去掉步骤内 if；release 名用 GITHUB_REF_NAME 动态化；在 upload 前补 release:new；明确只放行 Windows leg。

## 5.【High】【工程化】check:static 自研脚本体系：TS7 无编译器 API 被迫正则解析，工具链双轨
- **证据**：check-functions.ts:5-9 明言根 typescript@7 不暴露编译器 API（native port），采用正则解析；check-comments.ts:20-28 用正则提取 JSDoc 块；tools/typedoc/package.json 自建 typescript: ^6.0.2 子包绕开 TS7 跑 TypeDoc；check-tokens/check-comments/check-file-size/check-functions/check-test-boundary 五份脚本各自复制了一份 collectFiles 目录遍历器；check:static 链（package.json）= tokens+i18n+comments+file-size+functions+docs+secrets+test-boundary 8 道，其中 check:docs 每次 pre-push 都要用 TS6 环境全量跑 TypeDoc。
- **问题**：正则解析函数签名/JSDoc 必然产生误报漏报（复杂泛型、装饰器、解构等），豁免清单随之膨胀（check-file-size 的 EXEMPT、check-functions 的 EXEMPT_FUNCTIONS、check-test-boundary 的 exempt.json）；核心根因是选择 TS7 原生版，导致编译器 API 这一静态分析基础设施整体不可用，为此养了第二套 TS6 工具链——这是高维护成本换低收益的典型：5 处重复遍历器 + 双 TS 版本 + 6 个自研 tsx 脚本。
- **方向**：抽公共 walk/parse 库消灭 5 份 collectFiles；文件体积/参数个数类规则迁移到能表达为配置的工具（eslint 或 biome 规则）；TS7 兼容后再回归单一工具链，合并 TS6 typedoc 子包。

## 6.【Medium】【工程化】门禁与 AI 生成代码的豁免清单对抗：biome naming 规则 22 处 override
- **证据**：biome.json 中 useNamingConvention 出现 22 次，整个 src/main/infra/im/**、mcp/**、ai/tools/**、providers/**、多个 service 文件、全部 main 测试、搜索服务等被逐文件关停或放宽；knip.json 显式 ignoreDependencies 含 tree-sitter-wasms（动态 require.resolve 解析使 knip 失效）；check-file-size.ts 与 check-functions.ts 各带豁免名单。
- **问题**：useNamingConvention 默认强制 strictCase 与 AI 生成代码（snake_case 字段、PascalCase 类、混合风格）系统性冲突，治理方式是从规则退化为清单维护——每新增一块 AI 生成代码就要加一条 override，门禁的强制力与可信度都随清单增长而衰减。
- **方向**：把 naming 规则降级为 warn 或直接关掉默认 strictCase，改为只在关键边界（如 IPC schema 命名）用小范围 enforce；豁免清单设置只减不增的回归门槛。

## 7.【Medium】【测试】覆盖率门禁校准到实测-5 而非需求，且文档数据互相矛盾
- **证据**：src/main/vitest.config.ts:27-39 阈值 80/75/80/80，注释自称 14 批补测后实测 92.45/84.59/89.57（2026-08-12）；packages/shared/vitest.config.ts:20-31 阈值 branches:19 / functions:33，注释自述门槛 = 实测 - 5 点，分支 13→19、函数 28→33（2026-08-12 上调）；而 AGENTS.md 声称 main 当前约 66%，service 层为长期缺口；renderer 配置还把 app.tsx 从覆盖率排除。
- **问题**：三处叙事不一致（66% / 92% / 19%-33%），说明覆盖率数字没有单一权威来源；shared 包 19% 分支覆盖率被实测-5 合法化——对 schema/类型包可以理解，但 80/75/80/80 卡关的对外承诺与真实门槛（shared 19/33）是两套标准；门槛随实测浮动等于门禁追着现实跑，失去了反退化的语义。
- **方向**：统一覆盖率口径（CI 报告为准，AGENTS.md 删除过时数字）；shared 按类型包定位单独声明低分支阈值的理由，而不是用实测-5 含糊带过。

## 8.【Medium】【测试】E2E 三套配置维护成本高：浏览器模式测的是 mock，flaky 靠 retries 吸收
- **证据**：playwright.config.ts:11-14 明言渲染层已支持 mock fallback（api/client.ts），E2E 直接访问 localhost:5173 测试纯 Web UI——浏览器套件跑在 vite --mode web + src/renderer/dev/mock-api.ts 之上，不经过真实 preload/IPC；ci.yml e2e-browser 用 --retries=2 吸收 journey 套件偶发 flaky；三套配置（browser/electron/smoke）各自 testMatch、webServer、report 目录，CI 里对应 4 个 job（e2e-browser、e2e-electron 三平台、smoke-prod 双平台、integration 另算）。
- **问题**：浏览器模式验证的是 UI 对着 mock 数据渲染正确，与真实 IPC 路径（preload 沙箱、handler 包装、错误映射）完全隔离——这部分信号已被 electron/smoke 配置覆盖，浏览器套件边际价值低但占用一条 CI job；flaky 靠 retries 掩盖而非消除，说明断言或时序设计有问题；三套配置的 testMatch/依赖前置条件（smoke 需先打包）是持续维护负担。
- **方向**：合并浏览器套件进 electron 套件（或缩小为纯视觉/可访问性用例，保留 test:visual/a11y），只留 electron + smoke 两条真实链路；flaky 用例先修根因再谈 retries。

## 9.【Medium】【数据层】双持久化后端（SQLite vs localStorage）无统一版本/迁移策略
- **证据**：主进程 SQLite 管 sessions/messages/prompts/token_usage/turns/goals/memories/tasks/cron_tasks/skills（schema.ts 全表）；渲染层 zustand persist 管 settings（settings-store.ts）、drafts（draft-store.ts，key code-agent:drafts）、sidebar 偏好、activeSessionId（sessions-store.ts，key code-agent:active-session），create-persistent-store.ts:13-23 未配置 version/migrate 字段。
- **问题**：用户数据按进程/层被拆到两个存储后端：SQLite 有启动期备份/迁移逻辑，而 localStorage 侧无 schema 版本、无迁移钩子、无容量上限处理（仅静默降级内存）；settings 只活在 renderer localStorage，清缓存即丢，主进程（需要 settings 的服务）拿不到同一份数据；跨后端一致性（如删除会话时 localStorage 里的 activeSessionId/drafts 残留）依赖手工兜底（use-sessions.ts:138 清理）。
- **方向**：为 persistent store 补 version/migrate 并统一前缀管理；评估把 settings 这类主进程也要读的配置下沉到 SQLite（或主进程 JSON 配置），renderer 只留纯 UI 偏好。

## 10.【Low】【依赖】diff 渲染三套实现并存 + 双 MCP/chardet/croner 疑虑澄清
- **证据**：renderer 同时存在 (a) react-diff-viewer-continued（UnifiedDiffView.tsx:17 等 6 个组件引用，内部自带 diff-match-patch），(b) 直接 import { diff_match_patch } from 'diff-match-patch'（diff-stats.ts:12、line-diff.ts:16，用于语义统计），(c) 自定义 unified diff 文本解析（unified-diff.ts）；代码注释（file-diff-view.tsx:19、unified-diff.ts:4）宣称统一方案为 react-diff-viewer-continued 但迁移未完成；lockfile 实测 MCP 仅 @modelcontextprotocol/sdk@1.30.0 单一版本且 mcp/ 目录只用了 client 侧（双 MCP 包不成立）；chardet(0.2MB)+iconv-lite(0.3MB) 在 file-service.ts 做编码探测/转换、croner(0.1MB) 在 cron-service.ts，均属合理小依赖。
- **问题**：三个 diff 实现并存意味着渲染口径与统计口径可能不一致（同一次 diff 三套计算），react-diff-viewer-continued 是停更已久的社区 fork，长期依赖有维护风险；其余被点名依赖（chardet/iconv-lite/croner/diff-match-patch/MCP 单包）证据上均合理，无需处置。
- **方向**：完成统一方案收尾，diff 渲染收敛到单一组件，diff-match-patch 仅保留在统计工具内并隔离封装；评估 react-diff-viewer-continued 的替代（如 diff2html 或自研统一视图）。

## 11.【Low】【工程化/文档】CI 冗余与文档漂移：gitleaks 双跑、AGENTS.md 多处与代码库不符
- **证据**：ci.yml 有 gitleaks-action 步骤，同时 package.json check:static 内含 check:secrets = gitleaks dir src，同一扫描跑两遍；AGENTS.md 声称 tests/integration 当前为空，实测 22 个集成测试文件且 CI 有独立 integration-tests job；AGENTS.md 覆盖率约 66% 与 vitest 注释 92% 矛盾（见 #7）；.gitignore 残留 PostgreSQL 注释块（resources/pg/、download-pg.ts，数据库层已删除）；schema.ts 索引注释（#1 已述）为错误事实。
- **问题**：门禁脚本与 CI 步骤职责重叠（gitleaks 双跑是纯浪费）；AGENTS.md 作为给 agent 的运行时约束文档，其过时内容会误导后续 AI/人工维护者按错误假设行事（例如以为集成测试目录为空而重复搭建）。
- **方向**：check:static 内去掉 check:secrets（保留 gitleaks-action 单一入口）；安排一次 AGENTS.md 与代码库的对账修订，删除 PG 残留。

---

## 总体评价

这个仓库的工程化投入明显高于同类模板（IPC 定义表自动生成、Service Container、四层状态管理、三层测试+三套 E2E 都体现系统性设计），但存在两个结构性失衡：一是工具链复杂度超前于收益——TS7 原生版让编译器 API 不可用，逼出自研正则检查脚本和独立 TS6 TypeDoc 子包，叠加 22 处 biome override 和多个豁免清单，门禁的真实语义已经从规则漂移成清单维护；二是发布链路存在多个从未真正跑通的环节——Sentry 符号上传因 if 条件恒假永不执行、smoke 测试在 Linux/macOS 上必然失败、SQLite 迁移依赖启动期字符串匹配 ALTER，这些是发布/数据可靠性上最值得优先修复的点。数据层是最大隐患：Drizzle schema 与裸 SQL 双源真相在表数量膨胀到 11 张后必然漂移，应在引入下一张表之前完成版本化迁移收编。依赖方向数量合理但重量失控，体积门槛只测渲染层属于测错了对象，主进程 250MB+ 的 node_modules 才是安装包的真实大头。总体判断：工程化骨架优秀，但需要一次收敛——删冗余门禁、修发布死链路、把数据层迁移纳入版本管理，复杂度才能转化为真实可靠性。