# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.8.0-beta.3](https://github.com/zlh12331/superagent/compare/v1.8.0-beta.2...v1.8.0-beta.3) (2026-10-09)


### 修复

* **侧边栏移除「终止对话」按钮**：跨会话中断统一走对话区入口——点入对应会话后用输入框旁的停止按钮（或 Esc）即可，运行徽标保留（[#125](https://github.com/zlh12331/superagent/issues/125)）
* **提问倒计时依赖数组重构**：秒数计算提取为模块级纯函数、依赖改写为 `[active, deadline]` 数值依赖，清除 Biome useExhaustiveDependencies 双告警与失效的 eslint 抑制注释（[#125](https://github.com/zlh12331/superagent/issues/125)）

## [1.8.0-beta.2](https://github.com/zlh12331/superagent/compare/v1.8.0-beta.1...v1.8.0-beta.2) (2026-10-08)

<!-- changelog:polished -->

### 新增

* **对话真正用上你选的模型**：修复「界面所选模型」从未接线到对话回合的问题——此前选择只用于展示，实际请求仍走默认模型（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **自定义模型支持三种 API 格式**：Chat Completions / Responses / Messages 三选一，兼容更多 OpenAI 兼容与 Claude 风格端点（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **模型级超时**：可为单个模型配置总时长超时，长时间无响应不再无限等待（[#122](https://github.com/zlh12331/superagent/issues/122)）

### 修复

* **自定义模型端点 404**：端点 URL 收敛为单一真源，修复 `/v1` 被重复拼接（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **API Key 变更后仍用旧凭证**：设置/删除 Key 后立即重建 provider 缓存（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **并行审批卡死**：同一回合出现第 2 条审批时永不超时、回合永久挂起；状态机已支持并行多审批（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **僵尸审批卡**：审批超时/中断后界面残留等待卡片，决议已不再上报——现在有审批必有决议（[#122](https://github.com/zlh12331/superagent/issues/122)）
* **计划模式无法提问**：新增 control 工具类别，修复提问工具被「先批准才能提问」循环拦截（[#122](https://github.com/zlh12331/superagent/issues/122)）

### 改进

* 审批可见性：同一会话并行审批排队渲染不互相覆盖；侧栏会话行显示待审批徽标，跨会话也能看到哪个回合在等你（[#122](https://github.com/zlh12331/superagent/issues/122)）
* 提问弹窗队列化：一轮多个提问依次呈现，不再相互顶替（[#122](https://github.com/zlh12331/superagent/issues/122)）

## [1.8.0-beta.1](https://github.com/zlh12331/superagent/compare/v1.8.0-beta...v1.8.0-beta.1) (2026-10-08)

<!-- changelog:polished -->

### 修复

* **release:** merge job 下载后断言 6 个产物全部落盘 ([5a72656](https://github.com/zlh12331/superagent/commit/5a726562148e970c5ed9589f6ae969f37d3fd8be))
* **release:** 公告发帖的版块查询改用 slug 参数 ([8c4a2b1](https://github.com/zlh12331/superagent/commit/8c4a2b1f4108a9ede3fc09da23e50fc3e031849a))
* **release:** 锚点版本比较——prerelease 段追加方向写反（beta → beta.1 误报未前进） ([#120](https://github.com/zlh12331/superagent/issues/120)) ([5bf90ab](https://github.com/zlh12331/superagent/commit/5bf90ab29af9ed7994dd52bbe306b5bcd03c9c3a))

## [1.8.0-beta](https://github.com/zlh12331/superagent/compare/v1.7.1-beta...v1.8.0-beta) (2026-10-07)

<!-- changelog:polished -->

### 新增

* **community:** 讨论区开帖表单与度量覆盖 ([85b40b6](https://github.com/zlh12331/superagent/commit/85b40b6720e314d0588acf72090139a550cf125e))
* **community:** 讨论区运维补全——接纳工作流与公告联动 ([7be4bfb](https://github.com/zlh12331/superagent/commit/7be4bfba9797ef4111e6146637cbc3b8c79a6497))

## [1.7.1-beta](https://github.com/zlh12331/superagent/compare/v1.7.0...v1.7.1-beta) (2026-10-07)

<!-- changelog:polished -->

### 修复

* **ai:** 打通模型级总时长超时（runtime_models 新增 timeout_ms） ([a5146d3](https://github.com/zlh12331/superagent/commit/a5146d36e28d8015ef65cc40f2a61c907f1f62e2))
* **ci:** first-interaction 改 pull_request_target，修复 fork PR 必失败 ([6d651b1](https://github.com/zlh12331/superagent/commit/6d651b1ecf2ff485a0b0230a5e93f8fb5c484be8))
* **ci:** workflow run 块内插改经环境变量中转，收口脚本注入面 ([0f87345](https://github.com/zlh12331/superagent/commit/0f8734532f5f54681796fc94cebd0352885326c6))
* **diagnostics:** 修正脱敏注释中未实现的 base64 覆盖声明 ([2f62ef0](https://github.com/zlh12331/superagent/commit/2f62ef012ce741d01003ce3ba32430da980cb1ef))
* **models:** 连通性测试放行本机环回端点 ([2d49324](https://github.com/zlh12331/superagent/commit/2d4932438704e61f87883e49eda8cd2176031f58))
* **release:** scope 闸门对 package.json patch 缺失改 fail-closed ([88824f9](https://github.com/zlh12331/superagent/commit/88824f94a6531fdb17046d21c6c63de619be119e))
* **renderer:** 修复 a11y 三期扩页扫出的低透明度文字对比度违规 ([9cddb87](https://github.com/zlh12331/superagent/commit/9cddb87fcc019c94a8e1c1556812637435ca8801))
* **renderer:** 修复 a11y 扩页扫描发现的选中态对比度与可关闭标签违规 ([89ab1cc](https://github.com/zlh12331/superagent/commit/89ab1ccf10913f66cd995d28414cfacbafba55c9))

## [1.7.0](https://github.com/zlh12331/superagent/compare/v1.7.0-beta.3...v1.7.0) (2026-10-06)

> 🎓 **毕业版本**：1.7.0-beta.1 → beta.3 三个预发布版真机验证完毕，本版将其整体毕业为稳定版——是 1.7.x 首个面向稳定通道用户的版本。相对上一个正式版 1.6.2 的主要变化：① 打包版记忆资产登记修复（此前静默失败）；② 更新说明按 Markdown 结构渲染；③ 安装体积深度优化（引擎 bundle 单文件化，安装包内容约减半）；④ 发版链三道护栏自动化（影响发版质量与速度，用户侧无感）。beta 期间每个版本的详细说明见下方各 beta 段落。

### 修复

- **打包版记忆资产登记恢复可用**：修复打包产物缺失记忆引擎默认配置文件导致的记忆资产登记永久静默失败——运行时按编译位置找不到该文件即降级为警告，用户无感；现打包脚本显式补拷到运行时实际查找的位置，并在产物门禁新增数据文件断言，同类缺陷此后在发版前即被拦截（[#105](https://github.com/zlh12331/superagent/issues/105)）
- **web 模式 E2E 根治遗留 dev server 误复用**：浏览器模式 dev server 端口与 Electron 模式分离（5199 vs 5173），杜绝两套测试环境互相占用导致的连环假红（[#95](https://github.com/zlh12331/superagent/issues/95)）

### 优化

- **关于面板更新说明可读**：更新日志按标题、列表、链接等 Markdown 结构渲染（对齐 GitHub 上的显示效果），不再显示字面 HTML 标签，进入渲染层的 HTML 附纵深防御清洗（[#100](https://github.com/zlh12331/superagent/issues/100)）
- **安装体积与速度深度优化**：记忆引擎 bundle 单文件化（安装内容 282.8MB/7078 文件 → 35.6MB/180 文件量级），sidecar 就绪超时按慢磁盘场景放宽到 60 秒，安装与升级更快更稳（[#100](https://github.com/zlh12331/superagent/issues/100) 系列）
- **开源社区自动化第一批落地**：PR/issue 标签自动分组、新手引导、issue 指标统计三组 workflow + 23 个流程标签；发版链补三道自动化护栏（发版 PR 内容边界闸门、发版锚点自洽检查、锚点检查 fail-closed），从机制上杜绝此前连环发版事故的复发路径（[#97](https://github.com/zlh12331/superagent/issues/97)、[#106](https://github.com/zlh12331/superagent/issues/106)）

<!-- changelog:polished -->

## [1.7.0-beta.3](https://github.com/zlh12331/superagent/compare/v1.7.0-beta.2...v1.7.0-beta.3) (2026-10-06)

> ⚠️ **预发布版本（beta）**：本版修复一个影响打包版用户的功能缺陷（记忆资产登记静默失败），并给发版链补上三道自动化护栏。稳定版用户默认不会收到本版提示。验证稳定后随后续功能一并毕业为 1.7.0。

### 修复

- **打包版记忆资产登记恢复可用**：修复打包产物缺失记忆引擎默认配置文件（`metadata_config_params.json`）导致的记忆资产登记永久静默失败——bundle 单文件方案把引擎源码内联后，随源码散布的该文件被一并移除，运行时按编译位置找不到即降级为警告；现打包脚本显式补拷到运行时实际查找的位置，并在产物门禁中新增数据文件断言（配置注册表 JSON + 分词词典目录），此后同类「数据文件未随 bundle 走」的缺陷在发版前即被拦截（[#105](https://github.com/zlh12331/superagent/issues/105)）

### 工程与发版链

- **发版门禁收口（三道护栏自动化）**：① 锚点检查网络失败从「静默当作正常」改为 fail-closed（GitHub API 抖动时拒绝放行而非漏检），并接入 CD 在打 tag 前复核「版本号一致且 tag 尚未存在」（防重跑挪位）；② 新增 Release PR 内容边界闸门——发版 PR 只允许包含版本号与更新日志，携带任何代码即拒绝合并（此前曾发生代码搭发版车绕过全部 CI 的事故）；③ 两道检查均已接入 CI 自动执行，不再依赖人工记得跑（[#106](https://github.com/zlh12331/superagent/issues/106)）

<!-- changelog:polished -->

## [1.7.0-beta.2](https://github.com/zlh12331/superagent/compare/v1.7.0-beta.1...v1.7.0-beta.2) (2026-10-06)

> ⚠️ **预发布版本（beta）**：本版修复「设置 → 关于」更新说明的显示问题（GitHub 更新源交付的是渲染后的 HTML，此前按纯 Markdown 渲染导致字面标签直接显示在界面上），并修复发版链的版本号推导模型——beta 阶段的提交此后自动递增 beta 序号，无需逐个手写 Release-As 指令。稳定版用户默认不会收到本版提示。验证稳定后随后续功能一并毕业为 1.7.0。

### 修复

- **关于面板更新说明可读**：更新说明按标题、列表、链接等结构渲染（对齐 GitHub 上的显示效果），不再把 GitHub 渲染后的 HTML 当纯文本显示成字面标签，并对进入渲染层的 HTML 附纵深防御清洗（[#100](https://github.com/zlh12331/superagent/issues/100)）
- **发版链版本号推导修复**：修复版本化策略从未生效的问题——工作流输入绕过配置文件、组件前缀默认值翻转、配置缺 packages 键三层根因逐一排除；此后 beta 阶段 fix/feat 提交自动递增 prerelease 序号（本版 1.7.0-beta.2 即首个受益版本）（[#102](https://github.com/zlh12331/superagent/issues/102)、[#103](https://github.com/zlh12331/superagent/issues/103)、[#104](https://github.com/zlh12331/superagent/issues/104)）

<!-- changelog:polished -->

## [1.7.0-beta.1](https://github.com/zlh12331/superagent/compare/v1.6.2...v1.7.0-beta.1) (2026-10-06)

> ⚠️ **预发布版本（beta）**：本版以仓库基础设施为主（开源社区自动化第一批落地），产品功能无变化；稳定版用户默认不会收到本版提示。验证稳定后随后续功能一并毕业为 1.7.0。

### 新增

- **开源社区自动化第一批**：PR 打开时按改动路径自动打区域标签、首次 issue/PR 自动欢迎引导（含诊断包导出指引）、每周 Issue 运营指标统计——配套 label 体系重组（type/platform/status/priority 四组）与贡献指南（[#97](https://github.com/zlh12331/superagent/issues/97)）

### 修复

- **本地开发环境防复发**：浏览器模式 E2E 的端口与 electron-vite dev 分离（5199）——此前本地遗留的 dev server 会被测试误复用导致页面无 mock、测试连环失败且排查方向被误导（[#95](https://github.com/zlh12331/superagent/issues/95)）
- **依赖安全**：simple-git、knip、MCP SDK、cdxgen、source-map-js 升级，清零当日 npm 生态披露的 5 条安全通告；两条无补丁版本的开发链通告按惯例登记白名单并附移除条件（[#96](https://github.com/zlh12331/superagent/issues/96)）

<!-- changelog:polished -->

## [1.6.2](https://github.com/zlh12331/superagent/compare/v1.6.1-beta.4...v1.6.2) (2026-10-05)

> 本版本的核心是**记忆引擎在安装版中完整可用**：v1.6.0-beta 系列（未出正式包）把引擎改为单文件编译产物、依赖平铺与数据文件补齐——beta 系列真机验证 sidecar 已正常启动，本版为第一个包含完整修复的**正式版**，v1.5.0 用户将自动收到更新。

### 修复

- **记忆功能恢复可用**：修复记忆引擎在安装版中无法启动的问题（v1.4.0 起一直静默降级）——打包环境加载器失效、依赖链接被安装器展开、间接依赖与数据文件缺失四层问题逐一修复，引擎以单文件编译产物运行并补齐分词数据（[#91](https://github.com/zlh12331/superagent/issues/91)、[#92](https://github.com/zlh12331/superagent/issues/92)、[#71](https://github.com/zlh12331/superagent/issues/71)、[#73](https://github.com/zlh12331/superagent/issues/73)、[#75](https://github.com/zlh12331/superagent/issues/75)）
- **应用内升级提速**：升级安装耗时从约 17 分钟回落到 2-4 分钟量级——引擎运行目录从 282.8MB / 7078 个文件缩减为约 220MB / 38 个文件，打包剔除冗余的重复依赖实体；引擎冷启动同步加速（[#71](https://github.com/zlh12331/superagent/issues/71)、[#77](https://github.com/zlh12331/superagent/issues/77)）
- **关于面板更新日志可读**：更新日志按标题、列表、链接结构化排版展示，不再出现原始 Markdown 符号（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **引擎启动等待放宽**：安装后首次冷启动（机械盘 + 杀软逐文件扫描场景）的就绪等待由 20 秒放宽至 60 秒，消除刚升级后记忆功能「健康检查未通过」的误报（[#77](https://github.com/zlh12331/superagent/issues/77)）

### 内部改进

- **发版锚点自洽护栏**：合并 Release PR 前校验 tag、版本清单与发布标记三者一致（`pnpm check:release-anchor`），防止打包失败后版本链断裂导致版本推导错乱；同步确立「CD 全绿后才合并 Release PR」的发版纪律（[#93](https://github.com/zlh12331/superagent/issues/93)）
- **发布流水线效率**：Release PR 的 CI 只保留 CHANGELOG 润色门禁（实测 5 分钟 → 1 分半）；打包链路改动必须先通过本地完整打包验证（约 5.5 分钟）再推云端（[#89](https://github.com/zlh12331/superagent/issues/89)）
- 引擎打包链路：esbuild bundle 单入口 + 按原生绑定外置依赖的可达性裁剪 + BM25 词典压缩，入口校验与冒烟全通过（[#77](https://github.com/zlh12331/superagent/issues/77)）

<!-- changelog:polished -->

## [1.6.1-beta.4](https://github.com/zlh12331/superagent/compare/v1.6.0-beta.4...v1.6.1-beta.4) (2026-10-05)

> ⚠️ **预发布版本（beta）**：从 v1.6.0-beta.2 升级即体验全部改进（beta.3/beta.4 因发布流水线问题未出包，内容全部并入本版）。

### 新增

- **关于面板更新日志结构化展示**：更新日志按标题、列表、链接等排版渲染，不再出现原始 Markdown 符号（[#77](https://github.com/zlh12331/superagent/issues/77)）

### 修复

- **应用内升级大幅提速**：记忆引擎运行目录改为单文件编译产物（282.8MB / 7078 个文件 → 35.6MB / 180 个文件），升级安装耗时从约 17 分钟回落到 2-4 分钟量级；引擎冷启动同步大幅加速（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **升级安装更轻**：打包剔除冗余的第二份依赖实体（依赖提升后的私有层），安装写入量减半（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **引擎启动等待放宽**：安装后首次冷启动（机械盘 + 杀软逐文件扫描场景）的就绪等待由 20 秒放宽至 60 秒，消除刚升级后记忆功能「健康检查未通过」的误报（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **记忆引擎打包架构重建**：依赖链接在打包时被展开为断链导致安装包压缩失败的问题已修复，全部依赖平铺到运行目录顶层，不再依赖链接结构（[#79](https://github.com/zlh12331/superagent/issues/79)）
- **发版门禁修复**：发布流水线的完整性哨兵清单对齐新的引擎打包架构——1.6.0-beta.4 因此被误拦未出包，本版恢复发版通道（[#85](https://github.com/zlh12331/superagent/issues/85)）

### 内部改进

- 记忆引擎打包链路：esbuild bundle 单入口 + 按原生绑定外置依赖的可达性裁剪，入口校验与冒烟全通过（[#77](https://github.com/zlh12331/superagent/issues/77)）
- 发版通道自愈：修正 release-please 版本锚点与 tag 的不一致状态（[#81](https://github.com/zlh12331/superagent/issues/81)、[#88](https://github.com/zlh12331/superagent/issues/88)）

<!-- changelog:polished -->

## [1.6.0-beta.4](https://github.com/zlh12331/superagent/compare/v1.6.0-beta.3...v1.6.0-beta.4) (2026-10-05)

> ⚠️ **预发布版本（beta）**：beta.3 因发布流水线缺陷未能出包（版本号未占用，直接跳至 beta.4）。本版 = beta.3 计划内容 + 打包修复，是**完整可升级的版本**——从 beta.2 升级即体验全部改进。

### 修复

- **发布流水线修复**：修复依赖目录的链接在打包时被展开为断链、导致安装包压缩失败的问题——安装包构建恢复可用（[#79](https://github.com/zlh12331/superagent/issues/79)）

### 随 beta.3 计划内容一并包含（beta.3 未出包，首次发布）

- **升级安装提速**：记忆引擎运行目录改为单文件产物（282.8MB / 7078 个文件 → 35.6MB / 180 个文件），升级安装耗时预期从约 17 分钟回落到 2-4 分钟量级（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **关于面板更新日志可读**：更新日志按标题、列表、链接等结构化排版展示（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **引擎启动等待放宽**：安装后首次冷启动的就绪等待由 20 秒放宽至 60 秒，消除「健康检查未通过」误报；打包剔除冗余的第二份依赖实体（[#77](https://github.com/zlh12331/superagent/issues/77)）

### 内部改进

- 发版通道自愈：修正 release-please 版本锚点与 tag 的不一致状态（[#81](https://github.com/zlh12331/superagent/issues/81)）
- 引擎打包链路：esbuild bundle 单入口 + 按原生绑定外置依赖的可达性裁剪，入口校验与冒烟全通过（[#77](https://github.com/zlh12331/superagent/issues/77)）

<!-- changelog:polished -->

## [1.6.0-beta.2](https://github.com/zlh12331/superagent/compare/v1.6.0-beta.1...v1.6.0-beta.2) (2026-10-05)

> ⚠️ **预发布版本（beta）**：记忆引擎修复链的最后一环。beta.1 已让引擎入口跑通但仍有间接依赖无法定位；本版预期**完整恢复记忆功能**，请从 beta.1 升级后实际使用验证。

### 修复

- **记忆引擎启动链路收尾**：修复安装目录中引擎间接依赖无法定位的问题——应用打包链路会把依赖目录的链接展开为实体副本，引擎的中间层依赖（如分词哈希库）因此不可达；本版将全部依赖平铺到引擎运行目录顶层，不再依赖链接结构（[#75](https://github.com/zlh12331/superagent/issues/75)）

### 内部改进

- 依赖平铺实测零体积代价（引擎运行目录 282.8 MB / 7078 文件与上一版持平）（[#75](https://github.com/zlh12331/superagent/issues/75)）

<!-- changelog:polished -->

## [1.6.0-beta.1](https://github.com/zlh12331/superagent/compare/v1.5.0...v1.6.0-beta.1) (2026-10-05)

> ⚠️ **预发布版本（beta）**：用于真机验证向导式升级安装与记忆引擎修复，稳定版用户默认不会收到本版更新提示；想主动体验请在 设置 → 关于 打开「接收预发布更新」后点一次「检查更新」。验证稳定后将收敛为 1.6.0 正式版。

### 修复

- **记忆功能恢复可用**：修复记忆引擎子进程在安装版中启动失败的问题（1.4.0 / 1.5.0 实测受影响）——受影响版本的记忆功能一直在静默降级；本版起引擎以编译产物运行，不再依赖开发期加载器，从本版升级后将真正建立记忆（[#73](https://github.com/zlh12331/superagent/issues/73)）
- **引擎运行目录瘦身**：记忆引擎由源码直跑改为编译产物，运行目录 372 MB → 283 MB，应用内升级的安装等待相应缩短（[#73](https://github.com/zlh12331/superagent/issues/73)）

### 内部改进

- 记忆引擎打包链路重做：esbuild 转译出 dist 替代 tsx 源码直跑——打包环境 NODE_OPTIONS 被 Electron 剥掉导致 tsx 挂不上、Node 24 原生类型剥离不做 `.js`→`.ts` 导入映射，是启动失败的完整根因链；入口校验 fail-closed（[#73](https://github.com/zlh12331/superagent/issues/73)）

<!-- changelog:polished -->

## [1.5.0](https://github.com/zlh12331/superagent/compare/v1.4.0...v1.5.0) (2026-10-04)

> 本版本聚焦「等待可见」与「视觉可信」：更新安装改为向导式、进度全程可见，新增「接收预发布更新」开关，审批与提问等待均显示倒计时；同时完成一轮界面视觉深修（12 处对比度达标 + 多处静默失效修复）与 Agent 回合引擎的 XState 架构升级，并全量重写了 AI / Agent / 工具层注释（零逻辑改动）。

### 新增

- **更新安装向导化**：应用内更新下载完成后进入标准安装向导，安装进度全程可见，不再是一次无反馈的静默替换（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **接收预发布更新开关**：设置 → 关于新增「接收预发布更新」，稳定版用户可主动尝试 beta 版本，关闭即恢复只收正式版（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **审批等待倒计时**：权限审批弹窗实时显示剩余时间——主进程 5 分钟超时兜底不再是黑箱，等待多久、何时自动取消一目了然（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **提问等待倒计时**：Agent 提问对话框显示 60 秒自动继续倒计时，无人值守时回合不会被悄悄卡住（[#71](https://github.com/zlh12331/superagent/issues/71)）

### 修复

- **界面视觉深修**：修复亮色 / 暗色主题下 12 处文字对比度不达 WCAG AA 的问题；修复命令面板弹层不显示、滚动条留白透底、编辑器选区不明显、双动画互相打架等多处静默失效（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **回合稳定性**：修复模型级超时定时器清理链断裂——超时后残留计时器可能误触发后续回合的中断（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **更新行为**：退出时的自动安装按退出时刻的开关状态生效，不再沿用更早的旧状态（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **退出日志**：修复应用退出时异步日志缓冲未落盘、退出原因丢失的问题（[#71](https://github.com/zlh12331/superagent/issues/71)）

### 内部改进

- **Agent 回合引擎 XState 编排化**：回合状态机升级为编排者（层级状态 + invoked services），审批超时迁移为声明式计时（消除双计时源），回合装配段独立成模块（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **设计体系门禁扩容**：新增文字层纪律（语义基色禁作文字色）与字号、z 层级规则，动画门禁加固——防止视觉回归再次静默进入主干（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **全库注释重写（零逻辑改动）**：AI / Agent / 工具层约 45 批次修正过期、幽灵与失实注释并补齐接线背景；顺带清理两处零引用死代码，cron-service 迁移至 agent/ 目录（[#71](https://github.com/zlh12331/superagent/issues/71)）
- **其他**：事件循环延迟监控定时器补 unref；依赖审计口径与 CI 对齐（GHSA 白名单登记）；清理约 300 行验证过的死代码与死令牌（[#71](https://github.com/zlh12331/superagent/issues/71)）

<!-- changelog:polished -->

## [1.4.0](https://github.com/zlh12331/superagent/compare/v1.3.3...v1.4.0) (2026-10-01)

> 本版本是一轮大版本功能累积：设置页新增系统通知、网络代理、界面缩放、终端、快捷键、编辑器、数据库备份等一整批能力，并带来会话历史导出/导入、设置导出/导入、一键恢复默认、远程控制绑定范围等管理功能；同时修复多处影响回合稳定性的缺陷与托盘驻留问题，并升级依赖清零全部安全通告（含 8 条高危）。

### 新增

- **系统通知可自定义**：回合完成、回合失败、等待审批三类系统通知均可独立开关——此前通知无法关闭，多回合跑批时成为打扰（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **应用内网络代理**：支持跟随系统 / 直连 / 自定义 HTTP 代理三种模式，AI 对话、IM 渠道、MCP 工具、自动更新统一走代理，附「测试连接」一键探测——解决内网/防火墙环境下核心链路不可达的问题（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **界面缩放**：11 档界面缩放（设置页选择，或 Ctrl + = / - / 0 快捷键），高分屏、低视力与投屏场景友好；Windows 顶栏控件随缩放联动（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **终端设置**：新建终端可选默认 Shell（PowerShell / CMD / Git Bash / WSL / bash / zsh / fish，随平台列出可用项），终端字号可调并即时生效（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **快捷键自定义与独立设置分区**：六个常用快捷键（命令面板 / 新会话 / 搜索文件等）可录制修改，与其他键冲突时明确提示并拒绝写入；固定快捷键以速查表同页展示；帮助对话框（? / F1）可一键直达该分区（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **数据库备份可视化**：设置页可查看恢复点列表（含健康状态）、手动创建备份、一键恢复（重启后生效）（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **编辑器设置**：文件查看器支持自动换行开关与 Tab 宽度（2 / 4 / 8）调整（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **一键清空全部会话**：数据管理新增入口，带二次确认与「运行中回合」保护（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **会话历史导出 / 导入**：导出为版本化 JSON 文件、可跨设备迁移；导入幂等（同 id 会话自动跳过），个别损坏条目不影响整体导入（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **设置导出 / 导入**：全部应用设置可备份为 JSON 文件；API Key 等凭据因本机加密绑定不参与迁移（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **一键恢复默认设置**：所有应用设置整体回落默认，不影响 API Key、会话历史与渠道配置（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **审批等待通知**：后台回合弹出权限审批时提醒用户回来处理，避免回合停在等待状态无人知晓（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **跨会话运行指示**：侧栏会话项显示运行中徽标，可直接中断其他会话正在运行的回合（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **远程控制绑定范围**：可设为「仅本机」，不再向局域网广播发现端口（[#70](https://github.com/zlh12331/superagent/issues/70)）

### 修复

- **托盘驻留与开机自启**：修复静默启动后从桌面图标 / 开始菜单无法唤回窗口的问题；开启自启后开机不再弹出主窗口（按预期静默驻留托盘）；修正 Linux AppImage 自启路径与桌面规范（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **回合稳定性**：修复模型装配失败、请求超时、空回复三类场景下聊天界面永久转圈或状态错标的问题；上一回合异常收尾不再把新回合错误标记为空闲（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **设置生效**：修复清空自定义系统提示词后旧提示词仍持续生效的静默漂移；设置写入失败不再被静默丢弃（自动重试并计入诊断包）（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **安全加固**：内容安全策略（CSP）收敛为不外联，封堵被注入脚本向外部域名外渗的通道；数据库文件与备份在 Windows 上补齐权限收紧（与密钥库同级纵深）；封堵 MCP 工具参数绕过危险命令检查的口子（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **提问框**：提交失败时保留已填内容可原地重试；取消操作不再被失败锁死（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **密钥诊断**：Linux 无密钥环等场景下 API Key 无法读取时给出明确告警（随诊断包导出），不再表现为「密钥凭空消失」（[#70](https://github.com/zlh12331/superagent/issues/70)）

### 内部改进

- **性能**：首屏冷启动量化与记忆引擎包体积裁剪；流式文本主进程合帧（每 token 一条合并为 16–20ms 一帧）；Git 状态与 AGENTS.md 查询加缓存；会话导出改批量查询；终端输出缓冲改分片结构；记忆审计镜像清理异步化（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **依赖安全**：两批依赖升级清零 16 条安全通告（含 8 条高危 DoS），审计门禁恢复绿（[#70](https://github.com/zlh12331/superagent/issues/70)）
- **工程质量**：新增调试面板零残留门禁与 mutation 错误处理一致性门禁；覆盖率护栏改为不变式；提交信息校验兼容 worktree 布局；仓库钉死 npm 官方源（镜像环境审计不再误报）（[#67](https://github.com/zlh12331/superagent/issues/67)、[#70](https://github.com/zlh12331/superagent/issues/70)）
- **CI 修复**：发版 tag 钉在发布提交上（防重跑移动 tag 导致版本倒退）；双架构元数据断言修正（[#67](https://github.com/zlh12331/superagent/issues/67)、[#63](https://github.com/zlh12331/superagent/issues/63)）
- **文档**：code-wiki 11 篇与设计文档全量对账（逐项与代码实测核对）；新增 32 号新功能三阶段流程规范与 33-37 号功能规格（[#70](https://github.com/zlh12331/superagent/issues/70)）

<!-- changelog:polished -->

## [1.3.3](https://github.com/zlh12331/superagent/compare/v1.3.2...v1.3.3) (2026-09-21)

> 本版本修复 Windows 用户升级应用时被中断的问题，并加固发布流程——让有问题的构建在到达用户之前就被拦下。

### 修复

- **Windows 升级不再报错中止**：修复在旧版本上点「重启并安装」后，安装器提示「Failed to uninstall old application files」并中止、导致无法升级的问题。原因是安装目录内的文件路径过长（264 字符，超出 Windows 的 260 上限），旧版本清理阶段失败即中断。现已从两方面解决：缩短安装目录内的嵌套路径，并让安装器在旧版本清理失败时仍能继续完成安装（[#61](https://github.com/zlh12331/superagent/issues/61)）

### 内部改进

- **构建期拦截同类问题**：新增安装产物校验（原生模块架构、路径长度），若未来依赖变更导致路径再次超限或打进错误架构的二进制，构建阶段就会失败，不会把有问题的版本发到用户手上（[#59](https://github.com/zlh12331/superagent/issues/59)、[#61](https://github.com/zlh12331/superagent/issues/61)）
- **质量验证扩到六个平台**：单测与端到端测试从 1–3 个平台扩到 Windows / macOS / Linux 的 x64 与 ARM64 全平台覆盖，平台相关缺陷在合并前即可发现，不再等到发版（[#62](https://github.com/zlh12331/superagent/issues/62)）
- **自动更新链路加固**：双架构更新元数据改由独立步骤合并并加断言校验，避免某一架构的用户拿到另一个架构的更新包（[#62](https://github.com/zlh12331/superagent/issues/62)）

<!-- changelog:polished -->

## [1.3.2](https://github.com/zlh12331/superagent/compare/v1.3.1...v1.3.2) (2026-09-20)

> 本版本为 Linux 与 ARM 设备用户带来更完整的安装包：新增 RPM 格式与 ARM64 架构支持，
> 同时修复开机自启的若干问题。

### 新增

- **Linux 新增 RPM 安装包**：Fedora / RHEL / openSUSE 等发行版可直接安装（此前只有 AppImage 与 deb）（[#56](https://github.com/zlh12331/superagent/issues/56)）
- **全平台支持 ARM64 架构**：为 ARM 设备提供原生安装包——Windows on ARM（`.exe`）、Apple 芯片 Mac（`.dmg`，此前已有）、Linux ARM64（AppImage / deb / rpm）。ARM 设备上运行时不再经过 x64 兼容层，性能与功耗更好（[#56](https://github.com/zlh12331/superagent/issues/56)）
- **Linux 更新包按架构分发**：ARM64 设备自动获取对应架构的更新，不会误装 x64 版本（[#56](https://github.com/zlh12331/superagent/issues/56)）

### 修复

- **开机自启开关显示错误**：修复 Windows 上开关始终显示「关闭」（即使实际已开启）、且无法在应用内关闭开机自启的问题——原因是读取系统登录项时未传启动参数，与写入时不匹配（[#56](https://github.com/zlh12331/superagent/issues/56)）
- **开机自启时不再弹窗**：修复开启开机自启后，开机时应用仍会弹出主窗口的问题；现在按预期静默驻留系统托盘（macOS / Linux 同样适用）（[#56](https://github.com/zlh12331/superagent/issues/56)）
- **Linux 开机自启真正生效**：Linux 上此前开关可点但系统层面不会注册（表现为"看着成功、实际无效"），现按桌面环境标准（XDG autostart）正确实现（[#56](https://github.com/zlh12331/superagent/issues/56)）
- **macOS 开机自启状态更准确**：系统要求手动批准时给出明确提示，不再显示为「已关闭」造成困惑（[#56](https://github.com/zlh12331/superagent/issues/56)）

### 内部改进

- 新增安装包原生模块架构断言（读二进制头校验），防止「在 A 架构上为 B 架构打包」时静默产出无法运行的安装包（[#56](https://github.com/zlh12331/superagent/issues/56)）
- 修复提交标题规范的一个门禁缺口：此前形如 `fix(a)+build(b): …` 的双类型标题会被放行，但会导致发版流程静默阻断；现已在提交时拦截（[#57](https://github.com/zlh12331/superagent/issues/57)）

## [1.3.1](https://github.com/zlh12331/superagent/compare/v1.3.0...v1.3.1) (2026-09-19)

> 本版本修复更新流程中的两个问题：更新包偶尔会重复下载（差分下载完成后又转全量），以及点「重启并安装」后应用退出但安装未真正执行。

### 修复

- **不再重复下载更新包**：修复差分下载完成后校验失败、又从头下载完整安装包（约 300MB）的问题。原因是本地缓存的差分基准数据与实际安装包版本不一致，导致重建失败；现在下载前会先校验基准数据的一致性，不一致则自动改用匹配的基准，差分恢复正常（[#54](https://github.com/zlh12331/superagent/issues/54)）
- **「重启并安装」真正生效**：修复点击后应用退出、但安装程序未被执行（或未自动重新启动）的问题——此前退出后安装的执行链存在两处缺陷从未真正生效，现已修复并补充回归测试（[#54](https://github.com/zlh12331/superagent/issues/54)）

> 说明：本次修复仅在安装到 1.3.1 及之后版本时生效。当前运行的旧版本仍需手动安装一次 1.3.1（下载安装包运行即可），之后更新流程即恢复正常。

## [1.3.0](https://github.com/zlh12331/superagent/compare/v1.2.1...v1.3.0) (2026-09-19)

> 本版本让应用可以「关窗而不退出」：点关闭按钮默认最小化到系统托盘，正在执行的任务与会话继续运行；托盘中可直接新建/切换会话、查看更新状态、开关开机自启或彻底退出。

### 新增

- **关窗最小化到托盘**：点窗口关闭按钮默认隐藏到系统托盘而非退出，正在执行的任务、会话以及定时任务不会中断；可用托盘右键菜单「退出应用」或在 设置 → 通用 → 窗口 改回「关闭时退出应用」（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **托盘菜单**：右键托盘图标可直接新建会话、快速切换最近会话（最多 5 个）、顶部显示当前是否有任务在跑；更新相关动作也收进菜单——发现新版本时可检查更新、下载中显示进度、就绪后可直接安装（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **托盘图标状态提示**：鼠标悬停显示应用名；下载更新时显示百分比，更新就绪时提示可安装（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **开机自启开关**：设置 → 通用 → 窗口 新增「开机时自动启动」开关，托盘菜单中同一项也可直接勾选（两处状态实时同步）（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **命令面板新增「退出应用」**：以 Ctrl+K 打开命令面板即可彻底退出（走完整退出流程，不会残留后台进程）（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **托盘图标适配系统主题**：macOS 菜单栏图标自动跟随浅色/深色模式反色；Windows/Linux 按屏幕缩放比选用对应尺寸，高分屏下更清晰（[#52](https://github.com/zlh12331/superagent/issues/52)）

### 修复

- **退出确认不再重复弹出**：修复特定路径下（如 macOS 用 Cmd+Q、托盘退出）退出确认可能弹两次、或窗口已进入退出流程仍被误判为「关闭到托盘」的问题（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **更新状态推送更稳**：修复某个窗口异常时可能影响其余窗口接收更新状态推送的问题（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **新版本提示不再被误吞**：修复窗口刷新恢复状态后，同一阶段出现更高版本时通知被去重规则吞掉、看不到新版本提示的问题（[#52](https://github.com/zlh12331/superagent/issues/52)）
- **开发调试更新链路可用**：修复 `CODE_AGENT_DEV_UPDATE=1` 调试开关此前未接线、启用后仍提示「开发模式不支持」的问题；现在未打包环境也可跑通完整更新链路，便于验证界面（[#52](https://github.com/zlh12331/superagent/issues/52)）

### 内部改进

- 更新调试配置文件改为随构建自动落位，不再需要手工放置（[#52](https://github.com/zlh12331/superagent/issues/52)）
- 新增未打包环境下更新链路的端到端测试（含开关关闭时的门卫拦截），防止调试链路再次静默失效（[#52](https://github.com/zlh12331/superagent/issues/52)）
- 托盘图标资源改为从应用图标脚本化生成（模板剪影 + 多尺寸），图标更新后可一键重新生成（[#52](https://github.com/zlh12331/superagent/issues/52)）

## [1.2.1](https://github.com/zlh12331/superagent/compare/v1.2.0...v1.2.1) (2026-09-19)

### 修复

- **更新安装不再弹「无法关闭」**：修复点击「重启并安装」后安装器提示无法关闭应用、
  需要手动关闭再重试的问题——现在应用会先完全退出，再自动运行安装并重新启动，
  全程无需手动干预（[#49](https://github.com/zlh12331/superagent/issues/49)）
- **更新状态订阅去重**：修复关于面板与顶栏指示各自重复订阅更新状态、导致启动期
  多余请求的问题（[#49](https://github.com/zlh12331/superagent/issues/49)）

## [1.2.0](https://github.com/zlh12331/superagent/compare/v1.1.2...v1.2.0) (2026-09-18)

> 本版本为应用加入了完整的自动更新能力：打开应用即自动检查新版本，下载进度可见也可随时取消，更新在退出时自动安装。

### 新增

- **自动检查更新**：每次启动应用后自动检查一次；若网络不通会静默按 1/5/15 分钟重试，窗口长期开着也会定期复查。设置 → 关于新增「自动检查更新」开关（默认开启），关闭后仍可手动点「检查更新」（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **下载进度可见、可取消**：设置 → 关于显示当前下载的进度条、已下载/总量、实时速度与预计剩余时间；顶栏出现下载指示，点击直接跳到该界面；不想现在更新可以随时点「取消」（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新就绪与安装**：下载完成后顶栏显示提示徽标，可一键「重启并安装」；也可以选「稍后」或「跳过此版本」（跳过的版本不再提醒，出现更高版本会自动恢复提醒）。若当时有正在执行的任务，会先弹出确认框，避免打断正在进行的工作（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新说明**：就绪时可直接查看该版本的更新内容（即本 CHANGELOG 的对应段落），不用另外去翻发布页面（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **下载进度同步到任务栏**：Windows/macOS 任务栏图标会显示下载进度，无需留在应用窗口（[#47](https://github.com/zlh12331/superagent/issues/47)）

### 修复

- **更新失败看得懂**：检查/下载失败的提示改为分类文案（网络不可达、请求被限流、安装包校验失败、磁盘空间不足），不再直接抛出英文技术报错；无法归类时才保留原始信息以便排查（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **弱网下不再卡死**：修复检查请求可能永久挂起、导致此后「检查更新」按钮一直转圈且只能重启应用的问题（新增 45 秒超时，超时后自动恢复可重试）（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **窗口刷新后状态不丢**：修复刷新窗口后更新状态（下载中/已就绪）丢失、界面回到「检查更新」的问题（[#47](https://github.com/zlh12331/superagent/issues/47)）
- **更新缓存可清理**：设置 → 数据新增更新缓存占用展示与清理入口；清理前会提示「下次升级将改为全量下载」；下载进行中不允许清理，避免破坏在途下载（[#47](https://github.com/zlh12331/superagent/issues/47)）

### 内部改进

- 更新过程日志接入应用日志文件（此前走主进程控制台，打包后无从查看），排查更新问题时可随诊断包导出（[#47](https://github.com/zlh12331/superagent/issues/47)）
- 发布流程新增硬性门禁：安装包必须带差分更新产物（Windows/macOS 的 blockmap、Linux 元数据中的 `blockMapSize`），否则发布失败——防止差分更新静默退化为全量下载（[#47](https://github.com/zlh12331/superagent/issues/47)）
- 新增开发期调试开关 `CODE_AGENT_DEV_UPDATE=1`，可在未打包环境下走通更新链路以便验证界面（[#47](https://github.com/zlh12331/superagent/issues/47)）

## [1.1.2](https://github.com/zlh12331/superagent/compare/v1.1.1...v1.1.2) (2026-09-17)

> 本版本无应用功能变更，为发布流程与文档改进。

### 内部改进

- 发布说明加固：新增润色门禁——后续版本的更新说明若未改写为面向用户的文案，Release PR 将被 CI 阻塞无法合并；发版前还会二次校验，未通过则在打 tag 前失败（不占版本号、可重试）
- 新增 `pnpm release:draft`：展开版本区间内的提交明细生成底稿，降低撰写更新说明的成本
- 修正 v1.1.1 的发布说明：由内部提交标题改写为面向用户的表述

## [1.1.1](https://github.com/zlh12331/superagent/compare/v1.1.0...v1.1.1) (2026-09-17)

### 修复

- **记忆功能恢复可用**：修复记忆引擎子进程从未启动——此前每次对话都静默降级为「无记忆」，且已发布的安装包同样受影响（[08942aa](https://github.com/zlh12331/superagent/commit/08942aaedc0229096354b284f52f2fc957dc0102)）
- **亮色主题可读性**：修复首页、会话、设置三个界面共 59 处文字对比度不达 WCAG AA 的问题（列表时间、分组标题、空态提示、设置项标题等）；部分问题此前被失效的测试分支长期掩盖（[674e32e](https://github.com/zlh12331/superagent/commit/674e32e95e6479df01edaf36a9193ff97d6a97fe)、[#44](https://github.com/zlh12331/superagent/issues/44)）
- **终端面板**：修复创建失败时的高频重试（实测单次操作 12157 次 IPC 调用）、补齐方向键导航、显示真实标题与进程号（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **输入框与交互**：修复输入法组合输入期间误发送、快捷键提示文字对比度过低、待办队列在部分场景被误取消、设置项被写坏、文件树 `dirname` 根路径计算、vim `dd` 后状态残留等问题（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **欢迎页品牌**：文案与图标改为产品自有标识（不再使用第三方商标，与顶栏标识统一）（[#44](https://github.com/zlh12331/superagent/issues/44)）
- **修复会话切换时的订阅泄漏**：消息转换出错时未释放流式监听与定时器（[ce7267b](https://github.com/zlh12331/superagent/commit/ce7267b1be362128b81e6877df26301897a2a319)）

### 内部改进

- Web 抓取工具修复 HTML 实体二次解码与 `<script>` 变体剥离；API Key 不再有任何明文落盘路径（[09ce70c](https://github.com/zlh12331/superagent/commit/09ce70c2a595901da0c66e97e8a2f6afea66ecec)）
- 静态分析迁至 advanced setup 并排除 vendored 第三方源码，消除噪声告警（[4f5fa5e](https://github.com/zlh12331/superagent/commit/4f5fa5eb0ea6f6b3ced43e7b2df46a3458f5f907)）
- 新增 3 项工程门禁（动画 keyframes 引用、CSS 变量引用、写法一致性）并修复视觉回归门禁长期失效问题（[#44](https://github.com/zlh12331/superagent/issues/44)）

## [1.1.0](https://github.com/zlh12331/superagent/compare/v1.0.0...v1.1.0) (2026-09-14)


### Features

* 记忆引擎 vendoring 集成（9 批次）+ 发版链路加固 ([d70c938](https://github.com/zlh12331/superagent/commit/d70c9389e497555bba0fdab04b732d5e2a8ba012))


### Bug Fixes

* **ci:** 发布链路补 label 收尾，修复「开不出 Release PR」静默死锁 ([e10a98b](https://github.com/zlh12331/superagent/commit/e10a98b6ef938b8fee42c2c78ffc71595c7ff3ac))

## [1.0.0] - 2026-09-10

首个正式版本。

### 首发亮点

- 生产级 Code Agent 桌面端首发：Electron 44 + React 19 + TypeScript 三进程架构
- 多 AI 供应商可插拔路由（DeepSeek / OpenAI / Anthropic / Ollama）
- plan/build 双模式工作流（plan 只读探索，build 审批执行）
- 主进程 Service Container + IPC 定义表体系 + ipc/工具 CLI 脚手架

### 新增

- 即时通讯：QQ / 微信(ilink) / 企业微信 / 飞书 / 钉钉 / Telegram / webhook 七渠道消息收发与设置体系
- 远程控制：局域网设备发现、HTTP + SSE 命令通道、手机扫码配对开启控制页
- Agent 能力：多会话并发回合、定时任务（cron）、工作流编排工具、采样温度覆盖、上下文手动压缩、回合（含工具调用与思考过程）落库、prompt 注入真实 git 状态
- 记忆引擎：整体替换为 TencentDB-Agent-Memory（MemoryHub 服务）
- 模型与 AI：MCP SSE / streamable-http 传输与远端服务器管理、lsp_hover / code_symbols / codebase 工具、模型调用统一观测（wrapLanguageModel + telemetry）、模型管理页重构
- 渲染层：React Compiler（infer 模式）、shiki 语言按需加载、消息列表分页渲染、长会话自动压缩（opt-in）、vim 模式、快捷键接线、pinned 会话分组、目标栏（goal bar）、设置持久化迁移 SQLite、设计令牌重构、动效库与 Radix ToggleGroup
- 桌面集成：深度链接（code-agent:// 协议）、系统托盘、回合通知、系统主题联动、关窗协商
- 移动端：控制页二维码配对，扫码直开内置控制页

### 修复

- 可靠性：注册竞态 / 序号冲突 / 句柄泄漏等主进程缺口、数据库启动自愈、无头回合重复落库、记忆自动捕获与展示
- 安全：路径越权 / 命令绕过 / 参数注入 / 密钥外泄 / SSRF / 符号链接逃逸 / IM 群聊未授权执行等防御加固，传递依赖漏洞批量修复
- 渲染：a11y 对比度与键盘可达性、设置页崩溃风险、模型配置弹窗、消息分页越界、文件树刷新反馈、流式跟随与输入草稿交叉污染
- 构建与打包：NSIS 图标配置、memory-hub 资源打包、安装包排除 source map、postinstall 原生模块编译降级、覆盖率门禁参数透传
- 测试与 CI：flaky 与竞态修复、check-bundle 超限崩溃、Sentry 符号上传、release 流水线 memory-hub 变量

### 性能

- 编码检测只采样头部 64KB（2MB 文件读取 24s → 441ms）
- token 计数缓存、流式输出闸门、异步日志与 IO、SQLite 热查询索引
- 渲染层流式滚动 rAF 合帧、浮层与右面板懒加载拆分首屏 chunk
