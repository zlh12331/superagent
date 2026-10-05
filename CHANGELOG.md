# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.6.0-beta.3](https://github.com/zlh12331/superagent/compare/v1.6.0-beta.3...v1.6.0-beta.3) (2026-10-05)


### Features

* **about:** 关于页品牌化重设计——居中 Hero + 诊断复制 + 更新错误增强 ([00c87f2](https://github.com/zlh12331/superagent/commit/00c87f261dbf2440c144b042d938aa7e41a6429a))
* **agent:** 多会话并发回合支持（transport 分实例 + ask 会话隔离） ([dfce9cc](https://github.com/zlh12331/superagent/commit/dfce9cc000d77d2db9a39208fabbea2b4a5de6e7))
* **agent:** 接线 cron 调度生产链路（触发/恢复/销毁） ([effc70e](https://github.com/zlh12331/superagent/commit/effc70e72b3601b66163f6492e09f7e27859dd4d))
* **ai:** lsp_hover 工具暴露 + language server 按文件类型路由（内置四语言默认+用户覆盖） ([ddd9f44](https://github.com/zlh12331/superagent/commit/ddd9f44c5017c3f21b0ffdf8cbc19104b948e072))
* **ai:** mcp sse/streamable-http 传输支持 + 设置页远程服务器管理 ([4537a64](https://github.com/zlh12331/superagent/commit/4537a64f836a90ee1e288334b69dd7cbc2ed0ec6))
* **ai:** 接入 SDK repairToolCall 与 telemetry 模型级 span ([fd4a0e1](https://github.com/zlh12331/superagent/commit/fd4a0e18ac05991139ca45727e9a030fe3f655d3))
* **ai:** 通过 wrapLanguageModel 中间件统一模型观测 ([6c72cbd](https://github.com/zlh12331/superagent/commit/6c72cbdb0846006733f1f34ffc2c5f472044ec3b))
* **i18n:** 国际化本地化格式化落地（S6 审计根治） ([14fd290](https://github.com/zlh12331/superagent/commit/14fd290c70da4f5680336f1248ede7a3576e3c41))
* **main:** add runtime model display name and enable toggle ([51afbfa](https://github.com/zlh12331/superagent/commit/51afbfaf78ed47e84dffa2aecd065ab5ac7e2b38))
* **main:** agent 生成选项支持用户温度覆盖 ([417aeec](https://github.com/zlh12331/superagent/commit/417aeec46bdfddf23c56f272e01579d8e2fd2145))
* **main:** run_workflow 工具接线 - 工作流编排从死代码激活为模型可用能力 ([880300e](https://github.com/zlh12331/superagent/commit/880300e46d1ddf05d0b481f6fc73c42b87880bd8))
* **main:** 会话上下文手动压缩链路与落库 ([78359e1](https://github.com/zlh12331/superagent/commit/78359e119a8d46654cfd135f850cea858ac4c4a7))
* **main:** 会话消息落库与空回复防护 ([fbe2800](https://github.com/zlh12331/superagent/commit/fbe2800ec330927a61f35995b3f13248f04653a2))
* **main:** 供应链加固与排障闭环——asar完整性与SBOM/DB自愈/诊断导出/键盘e2e ([f53a88f](https://github.com/zlh12331/superagent/commit/f53a88ff1ea8692afac343e3f338fbf7acf31c0a))
* **main:** 回合落库包含工具调用与思考过程，重开会话可见 ([402aa88](https://github.com/zlh12331/superagent/commit/402aa88c8c233b2a1e827543f64f0754951999ed))
* **main:** 文件树忽略模式过滤 - 内置 node_modules 基线 + 用户配置现读即生效 ([446a338](https://github.com/zlh12331/superagent/commit/446a338f07e2e1217b93a89dabed21a85bd7df12))
* **main:** 桌面系统集成完善——深度链接/系统托盘/回合通知 ([809e83a](https://github.com/zlh12331/superagent/commit/809e83adf2b6dd96d7d89f01d2a7fe6a8756bbd0))
* **main:** 注入 gitSummaryProvider，prompt 显示真实 git 状态 ([a784807](https://github.com/zlh12331/superagent/commit/a784807f8a534a97e260c507b18c17c072b57426))
* **main:** 移植远端安全加固 H1/H2/H3 - 遥测开关对齐/IM 沙箱工作目录/敏感文件 0600 ([ad864a9](https://github.com/zlh12331/superagent/commit/ad864a960736081fd98d63d6eab3219e649a546c))
* **main:** 记忆后端整体替换为 TencentDB-Agent-Memory（MemoryHubService） ([a8a5c3f](https://github.com/zlh12331/superagent/commit/a8a5c3f803b282747ebefc96ef4491de27961e9c))
* **main:** 远程控制阶段 2.5，局域网命令可驱动 Agent 无头执行 ([4664fa5](https://github.com/zlh12331/superagent/commit/4664fa58b4462f71f892ba905ffbef180aef1574))
* **main:** 远程控制阶段 3，命令支持 SSE 增量回传并内置手机控制页 ([1338566](https://github.com/zlh12331/superagent/commit/1338566deb7c4a47036832ac0b12c5ecd4eedd71))
* **remote:** 远程控制阶段 2 落地（HTTP 桥接 + UDP 局域网发现） ([377a07f](https://github.com/zlh12331/superagent/commit/377a07f049070b66d4e347d66d0994a5081ca395))
* **renderer:** add mock demo commands to slash panel ([5f5b2e6](https://github.com/zlh12331/superagent/commit/5f5b2e69b6128f8e8a7fb2ecfa6c247536f165e1))
* **renderer:** add tool error state to /demo stream ([32d0ec9](https://github.com/zlh12331/superagent/commit/32d0ec9e1f1faa094acfdbe1e3ecbde7f7fa1e74))
* **renderer:** agent 流 sessionId 回显契约守卫 ([3769b36](https://github.com/zlh12331/superagent/commit/3769b3645905eed843e9d65a83ce594861df4afc))
* **renderer:** composer and panel polish per annotations ([ffd491f](https://github.com/zlh12331/superagent/commit/ffd491f74d9bc3543d4c4886d9f65f24d91a51ba))
* **renderer:** goal bar above composer with editable actions ([7138217](https://github.com/zlh12331/superagent/commit/7138217c432c0df691dd06322ea567994f740dc9))
* **renderer:** goal bar accent styling and status states ([0240bc0](https://github.com/zlh12331/superagent/commit/0240bc080bec7e320fe312c676f31abbd0ae5c74))
* **renderer:** mock /demo stream for all message part types ([2949f1e](https://github.com/zlh12331/superagent/commit/2949f1ef36d96fb7214df2edbfa91171a5db1682))
* **renderer:** mock rate-limit trigger for pill banner dev ([8dc4227](https://github.com/zlh12331/superagent/commit/8dc422785a0d61d789eee3638d61563959f2a774))
* **renderer:** pin visual distinction and remove dead file ops ([4aac4cc](https://github.com/zlh12331/superagent/commit/4aac4cc30d098f21a1cc864a2bba47e3a747400f))
* **renderer:** pinned sessions float to list top without group label ([3cd704b](https://github.com/zlh12331/superagent/commit/3cd704b9591079db7cf119a8a061cc3f45d34f6d))
* **renderer:** pinned sessions in dedicated top group ([70843de](https://github.com/zlh12331/superagent/commit/70843de24e149e1f379833fa8f1b78eba89c40ff))
* **renderer:** rebuild model management page with list and dialogs ([8ee38c1](https://github.com/zlh12331/superagent/commit/8ee38c1c7cbb56c698689e4d2eef3ccd2df50765))
* **renderer:** remove file tree node more-actions menu ([f22f32f](https://github.com/zlh12331/superagent/commit/f22f32f4e462d4c81b2f0bcdf6591ebd22569613))
* **renderer:** replace native select and radio with shadcn components ([849199b](https://github.com/zlh12331/superagent/commit/849199b7e7effce782c6ad436369cca919d6323c))
* **renderer:** shiki 语言按需加载（bundle/web + loadLanguage）并新增首载体积门槛 ([39a213f](https://github.com/zlh12331/superagent/commit/39a213faa97e9128bc712f7dc14cf6511ea62b7a))
* **renderer:** simplify goal interaction to direct send only ([f4f2568](https://github.com/zlh12331/superagent/commit/f4f256888803403109daa64d8b8b741c56fe291e))
* **renderer:** 实验性长会话自动压缩（opt-in 默认关） ([ce187f5](https://github.com/zlh12331/superagent/commit/ce187f5bc697954720cfdb1263772b9d83c8296e))
* **renderer:** 工作区设置分组落地 - 忽略模式/默认展开层级配置与文件树自动展开链 ([d342542](https://github.com/zlh12331/superagent/commit/d3425424d79c5db39ac075bec879e67443fe4df9))
* **renderer:** 引入 MotionVault 动效库并落地核心界面动效 ([633f2ce](https://github.com/zlh12331/superagent/commit/633f2ceef49c1ddeb1a301105f0eca32aa9c8a82))
* **renderer:** 引入 Radix ToggleGroup，统一互斥切换控件 ([57193d6](https://github.com/zlh12331/superagent/commit/57193d6cffe32d487b1375ea350941d84a6f5999))
* **renderer:** 快捷键 Ctrl+S/Ctrl+N 真接线与文件查看器脏数据保护 ([8a10765](https://github.com/zlh12331/superagent/commit/8a107659be5912dd99479e7fc8dff2e1691313a0))
* **renderer:** 浏览器 pane 配置项落地（默认预设/缩放 + 严格沙箱） ([11563f6](https://github.com/zlh12331/superagent/commit/11563f649456df330ef0b8e796e6442ad1b24987))
* **renderer:** 消息列表分页渲染（长会话性能根治，方案 A） ([8aa469e](https://github.com/zlh12331/superagent/commit/8aa469ef3cabcaa7c73f67f3ea3b2555ec3bc7a1))
* **renderer:** 移动端配对二维码，扫码直开内置控制页 ([962b9ce](https://github.com/zlh12331/superagent/commit/962b9ced4eb5bb7750719d7a52702a2d2c6768e7))
* **renderer:** 经 oxc 通道启用 React Compiler（infer 模式）+ check:compiler 静默失效门禁 ([fcd36c9](https://github.com/zlh12331/superagent/commit/fcd36c9372dc71768b353b150742bf829b0b3b8a))
* **renderer:** 设置「移动端」接入远程控制面板（启停 + 令牌配对） ([ed077ef](https://github.com/zlh12331/superagent/commit/ed077ef669fbca3e2ae216630522fe54aa0fbdab))
* **renderer:** 设置持久化迁移至 SQLite（localStorage 合并） ([c745be9](https://github.com/zlh12331/superagent/commit/c745be99258b7288c4e97146f5423a661996b053))
* **renderer:** 设置项温度/系统提示词/扫描线接入真实消费 ([ce4fedf](https://github.com/zlh12331/superagent/commit/ce4fedf805a424eeeeab63a282ae2fa436771f92))
* **renderer:** 设计令牌重构 + DevPanel 右面板透明 + 新增 .design 设计资源 ([51e1761](https://github.com/zlh12331/superagent/commit/51e17613d74749082f20a92099a4b190c166ba41))
* **renderer:** 语言服务器设置分组与工作区配置 UI（lsp.serverCommands 写穿透） ([f6e622b](https://github.com/zlh12331/superagent/commit/f6e622bcf1eb53ef193022a7a9d4d0195dc8306c))
* **renderer:** 输入舱 vim 模式与侧栏 tabs 方向键导航 ([7051d53](https://github.com/zlh12331/superagent/commit/7051d53f6ada362536c4664c852f4bd31f65e776))
* **scripts:** memory-hub 打包资源精简重型平台二进制 ([fd25e9e](https://github.com/zlh12331/superagent/commit/fd25e9e84b32718e8ee894e9a5d428134fb00ad2))
* **scripts:** 函数体长分档 100/200/400 + &gt;400 档登记理由 ([1767fdc](https://github.com/zlh12331/superagent/commit/1767fdcba2c784ca3a78c1e2758fbf197824a62e))
* **shared:** add updateRuntimeModel and models:test IPC contracts ([cd1c13b](https://github.com/zlh12331/superagent/commit/cd1c13bc7c2ab85597f39ae10395b3d9ceb1c0b9))
* **shared:** agent 域新增采样温度契约与校验测试 ([7d3b239](https://github.com/zlh12331/superagent/commit/7d3b23919c26cacb227119549834e881dbc6b312))
* **shared:** session:compact 上下文压缩契约 ([3f8dcdb](https://github.com/zlh12331/superagent/commit/3f8dcdb5b24affa5a7daf777a6a19ad1bedece5b))
* **shared:** 空回复错误码 AI_EMPTY_RESPONSE ([ec15bd1](https://github.com/zlh12331/superagent/commit/ec15bd17cf02bccc8b1d53a7b6593dc5dfe320de))
* **storage:** 新增老库升级增量迁移，打通旧 schema 平滑升级路径 ([18fa780](https://github.com/zlh12331/superagent/commit/18fa7801b04f00496f9b9e8d2b3aff8a56a537e7))
* **storage:** 补齐会话内序号唯一约束（0003 唯一索引） ([d667e1b](https://github.com/zlh12331/superagent/commit/d667e1b4b712effb09304e9bd99005e19ab75018))
* **tools:** codebase 注册为 Agent 工具（懒索引 + 三平台打包分发） ([4824e3f](https://github.com/zlh12331/superagent/commit/4824e3f9040e94693eed6a28ec5fdd91856dd254))
* **tools:** 新增 code_symbols 工具并暴露记忆 L1/L0 检索模式 ([48dd5ee](https://github.com/zlh12331/superagent/commit/48dd5ee6fa43ee047577e148d398c656d6068aaf))
* **tray:** 托盘后台驻留 + dev 更新链路修复 + 托盘图标资源落地 ([#52](https://github.com/zlh12331/superagent/issues/52)) ([aaf229b](https://github.com/zlh12331/superagent/commit/aaf229b8c3eaf509be155fc254ba7965b4e53c2e))
* **ui:** dynamic right panel tabs and ui cleanup ([a6d9ca7](https://github.com/zlh12331/superagent/commit/a6d9ca7b1796a82b1d008fc740cd89f5de112ae3))
* **ui:** file tree shows content in right panel ([1298f06](https://github.com/zlh12331/superagent/commit/1298f065a79aed0aa266188ed03cc0e6771814f2))
* **ui:** merge files tab into diff pane ([8eb6eb4](https://github.com/zlh12331/superagent/commit/8eb6eb4e573aed79ffbb4d31a90fd9dfa634f24c))
* **ui:** remove redundant topbar back button ([a125226](https://github.com/zlh12331/superagent/commit/a1252264dee7f56e129fcf474ec4859dde00e9e4))
* **ui:** session menus file tree terminal polish ([1993afd](https://github.com/zlh12331/superagent/commit/1993afd7844ae10d1e5b70d4da0c84fe7b9ab4cd))
* **ui:** slash panel width goal bar polish ([9159a47](https://github.com/zlh12331/superagent/commit/9159a47c0b6e1ff76aa6865cab04879a4d0bcc13))
* **ui:** 账户菜单重设计——设置/语言/主题/报告问题 4 项交互 ([345322d](https://github.com/zlh12331/superagent/commit/345322d2c94f7c94099c4b74b685812e1fa07c33))
* **update:** 自动更新系统——启动检查、进度可取消、跳过版本、缓存清理与发布门禁 ([#47](https://github.com/zlh12331/superagent/issues/47)) ([b6c78a0](https://github.com/zlh12331/superagent/commit/b6c78a0aeb3823dee24859bd3f77d9de2319bee3))
* 后台驻留修复链落地 + 设置面补全（33-37 号）+ code-wiki 全量对账 ([#70](https://github.com/zlh12331/superagent/issues/70)) ([6683c57](https://github.com/zlh12331/superagent/commit/6683c57d3fee09ab912a6b7ff0014f61846c3eb9))
* 新增关窗协商、主题联动与渲染自愈机制 ([22aea39](https://github.com/zlh12331/superagent/commit/22aea39604d2b0b58bc9582e34553fe886e955e4))
* 更新安装向导化 + 审批/提问等待可见化（38 号决策面）+ CSS 三轮深度审查 + AI 层注释重写 ([#71](https://github.com/zlh12331/superagent/issues/71)) ([090a943](https://github.com/zlh12331/superagent/commit/090a943cf93ce1de3b088d12e3fbfe4792157950))
* 记忆引擎 vendoring 集成（9 批次）+ 发版链路加固 ([d70c938](https://github.com/zlh12331/superagent/commit/d70c9389e497555bba0fdab04b732d5e2a8ba012))


### Bug Fixes

* **agent:** transport configure undefined 不覆盖 ([32c255d](https://github.com/zlh12331/superagent/commit/32c255d22cf847c85035a3f97e84b2fb0cb0a85f))
* **agent:** transport 配置兜底修正 + 死链路删除后的文档同步 ([e949716](https://github.com/zlh12331/superagent/commit/e94971650b19eae36c13106c2cc5752e1d356b3c))
* **ai:** 上下文预算计入 system 与工具开销 + 补齐 includeUsage + 端点归一 ([86b3616](https://github.com/zlh12331/superagent/commit/86b3616402bc9fba209a4ea214625bc6e29194a9))
* **build:** memory-hub 打包缺 node_modules（extraResources 跳过） ([18f11a9](https://github.com/zlh12331/superagent/commit/18f11a9c9d9c21441f5450a07a9b3f004cea09ad))
* **build:** 修 Windows chokidar 崩溃与 macOS 空 CSC_LINK 'not a file' ([c7b6773](https://github.com/zlh12331/superagent/commit/c7b6773c1bfa11651955d4f6b1369664eb993a1d))
* **build:** 修复 test:coverage 参数透传，三层覆盖率门禁首次真正生效 ([7441be1](https://github.com/zlh12331/superagent/commit/7441be161ece0272e559186cfc2ab11944606100))
* **build:** 安装包排除 source map，实测 asar 内 98.4MB 产物不再随包分发 ([d42795d](https://github.com/zlh12331/superagent/commit/d42795dae78918024860b0289f86eda4b6a97009))
* **build:** 移除 web 模式中被静默忽略的 React Compiler 配置及孤立依赖 ([d72c3f8](https://github.com/zlh12331/superagent/commit/d72c3f8e6040ef97b5606e56091acf1ffe325878))
* **chat:** 渲染链修复——分页/流式跟随/孤儿工具卡/图片恢复/多类定时器清理 ([a04bfcb](https://github.com/zlh12331/superagent/commit/a04bfcbd1ef968853c60cfdef04f37eba4ba1e06))
* **chat:** 输入链修复——草稿交叉污染/Esc 数据丢失/发送防重/键盘可达性 ([35715ab](https://github.com/zlh12331/superagent/commit/35715abc5fa2e744defed472b62a51627f8d9379))
* **ci:** electron E2E 加 retries=2 吸收共享 runner 性能抖动 ([#25](https://github.com/zlh12331/superagent/issues/25)) ([e5ae067](https://github.com/zlh12331/superagent/commit/e5ae0674d72f0d047e70ee7cd5a54ae234fc4585))
* **ci:** release job 的 tag 钉在发布提交上（修重跑移动 tag 的事故） ([#67](https://github.com/zlh12331/superagent/issues/67)) ([3bfb8a5](https://github.com/zlh12331/superagent/commit/3bfb8a5a16b2117a8d43da729193b6d1dbc65fd7))
* **ci:** release smoke 补 xvfb + file-service 测试禁用 chokidar 原生监视规避 Windows 崩溃 ([2a1ee91](https://github.com/zlh12331/superagent/commit/2a1ee91ce26250c273e9e2b5ccc23c399027b3ce))
* **ci:** release 流水线补 memory-hub 变量并统一 sentry release 命名 ([e6baaf4](https://github.com/zlh12331/superagent/commit/e6baaf4e0371f674422333f942b120b28f802fa1))
* **ci:** 修正 publish 的双架构元数据断言正则（首版漏判真实产物） ([#63](https://github.com/zlh12331/superagent/issues/63)) ([1f1a66b](https://github.com/zlh12331/superagent/commit/1f1a66b416c69b3bf168ef78720530d36202cf8e))
* **ci:** 发布重构——三平台构建成功后才打 tag/发布，空版本不再占号 ([a49a7b5](https://github.com/zlh12331/superagent/commit/a49a7b5daa481b2ec31465106ca5eddc4d61d654))
* **ci:** 发布链路补 label 收尾，修复「开不出 Release PR」静默死锁 ([e10a98b](https://github.com/zlh12331/superagent/commit/e10a98b6ef938b8fee42c2c78ffc71595c7ff3ac))
* **ci:** 补严格提交标题门禁 + 解除被双 type 标题阻断的发版通道 ([#57](https://github.com/zlh12331/superagent/issues/57)) ([9dd436c](https://github.com/zlh12331/superagent/commit/9dd436c57e1f749f95ef51f1146365d4fbf87af0))
* **ci:** 静态分析改 advanced setup 排除 vendored 源码 + 补 ci.yml 权限块 ([4f5fa5e](https://github.com/zlh12331/superagent/commit/4f5fa5eb0ea6f6b3ced43e7b2df46a3458f5f907))
* **deps:** 升级传递依赖根治三条安全告警并清空死豁免 ([4f41fe1](https://github.com/zlh12331/superagent/commit/4f41fe198f5d2b6ccdf2e8ab2051edc739c9234d))
* **deps:** 补齐未声明依赖并修复 pnpm 11 构建决策 ([0c5c68c](https://github.com/zlh12331/superagent/commit/0c5c68c9cb540f40161e43ae4e1d28bdb31878dd))
* **dev:** mock agent.run 返回裸对象 ([edb8bc1](https://github.com/zlh12331/superagent/commit/edb8bc1d3f83b89a759de13ae84f89689c566db3))
* **dev:** mock apiKey localStorage 持久化 ([dff6192](https://github.com/zlh12331/superagent/commit/dff61922fdaec4dd315ca5a8c8e4939d9d5d8ba0))
* **docs:** tools/typedoc 降回 TS6 修复 check:docs 失败 ([3bd1334](https://github.com/zlh12331/superagent/commit/3bd1334efb95de08aecb20ba35140c3c0e330c77))
* **e2e:** electron E2E 可靠性修复与断言对齐当前实现 ([3edf5f8](https://github.com/zlh12331/superagent/commit/3edf5f8ba628cad68f0c344ee2876514fe4fbc6b))
* **e2e:** playwright webServer 显式指定仓库根 cwd ([4cfa146](https://github.com/zlh12331/superagent/commit/4cfa1469ad1656cbe603ad61547835964f6a213f))
* **e2e:** 主窗口固定桌面视口，补齐右面板断言前置条件 ([9ac1739](https://github.com/zlh12331/superagent/commit/9ac17392bae55958d85b92e223fc9773edcfde88))
* **e2e:** 修复 check-bundle 超限崩溃与 a11y 对比度空跑 ([8c6e652](https://github.com/zlh12331/superagent/commit/8c6e652f1d9f76d6d50bd3027ac8653416f05a4f))
* **file:** read 超限文件明确报错防 OOM + 文档契约同步 ([5293766](https://github.com/zlh12331/superagent/commit/5293766d246d74dfc0591fa79fb6de9febce41db))
* **file:** 用户手势授权放行 OS 选择器选中的文件，修复附件读取被工作区边界拒掉 ([5a17f7c](https://github.com/zlh12331/superagent/commit/5a17f7cffe17f7bd0bb39f4f776d3056d36e5f85))
* **git:** add paths 与 diff ref 可选参数防御 ([38b9c09](https://github.com/zlh12331/superagent/commit/38b9c09d8e0f41850b03e0390cacaf7ca3cf316d))
* **i18n:** 补缺失错误码 AI_MODEL_NOT_CONFIGURED 文案 ([4b1c9c8](https://github.com/zlh12331/superagent/commit/4b1c9c8a709f8dff60d3a5418f34016fe84a1fbb))
* **im:** im/远程沙箱目录改使用点求值对齐 userData 重定向 ([cfc1ced](https://github.com/zlh12331/superagent/commit/cfc1cedacdb114b2d3c85ada770b3e08f592c100))
* **ipc:** /compact 响应加 reclaimedTokens，落库与文案改 token 口径 ([c17fec3](https://github.com/zlh12331/superagent/commit/c17fec39eeade934f574a224cad1bc71003518d1))
* **main:** app_settings 表 + 设置读写服务（设置下沉 SQLite） ([ce4b68a](https://github.com/zlh12331/superagent/commit/ce4b68ad4e64df6a5eb3c25865bafae84b6e9637))
* **main:** csp 放开 wasm-unsafe-eval 修复 shiki 高亮全失效 ([7314ca1](https://github.com/zlh12331/superagent/commit/7314ca1e3096e835247aae7f83d66d3444e00d3b))
* **main:** drizzle 迁移目录增加候选路径探测 ([b2f6bdb](https://github.com/zlh12331/superagent/commit/b2f6bdbe0d634e0a130103a6e86982ebf302904f))
* **main:** goals 列表排序加 id 次级键，消除同毫秒 createdAt 平局的 flaky ([6114e26](https://github.com/zlh12331/superagent/commit/6114e2629b7359939426ce5b026925d6b1cfa63c))
* **main:** postinstall 原生模块重编译失败降级为告警 ([aafee38](https://github.com/zlh12331/superagent/commit/aafee3830379204933519d58255014bb64c53457))
* **main:** postinstall 改直调 electron-rebuild CLI 修复部分环境必败 ([07b487e](https://github.com/zlh12331/superagent/commit/07b487e50be2b930a9d42b01d37e11865c33c837))
* **main:** terminal 工具 schema 扁平化修复 DeepSeek 400 ([c8b3789](https://github.com/zlh12331/superagent/commit/c8b3789a38d60521d0052d1145abceb78200dd08))
* **main:** uncaughtException 落盘后退出 + cron 不抢占会话 + 冷启动 deep-link + 告警现场 ([075496f](https://github.com/zlh12331/superagent/commit/075496f5b13cf23cba0bf83a893c3c2d0978c039))
* **main:** watcher usePolling 条件展开，适配 exactOptionalPropertyTypes ([43e53c8](https://github.com/zlh12331/superagent/commit/43e53c8029e587bd8a98639c3c20663b050d2b55))
* **main:** 上下文 token 估算补齐工具负载并改为两档裁剪 ([f3c9c61](https://github.com/zlh12331/superagent/commit/f3c9c61ea8c7435ff8ec9c39d01b056b98724e73))
* **main:** 上下文压缩切点补齐工具调用配对，消除孤儿 tool_result ([2ec8a08](https://github.com/zlh12331/superagent/commit/2ec8a085fa0f3579ca9e2b8b5e64fc4d902681aa))
* **main:** 会话 id 取自 create 返回值，IM 回合 transcript 真正落库 ([053b218](https://github.com/zlh12331/superagent/commit/053b2189a9c5d3fe4fbb8cb16b0cf1d3e14b5763))
* **main:** 修复数据库自愈不可达、无头回合重复落库与资源泄漏 ([059f84f](https://github.com/zlh12331/superagent/commit/059f84fbd55cd0a3637e254a85b453dfb3a1c29d))
* **main:** 修复模型停用后仍可路由 ([ac41f01](https://github.com/zlh12331/superagent/commit/ac41f01b8ae0a1b2c5232221c642cfd18d6ba937))
* **main:** 修复注册竞态/seq 冲突/句柄泄漏等 10 项可靠性缺口 ([c3b24b9](https://github.com/zlh12331/superagent/commit/c3b24b9f914bfd91aef5fe6404c28527e1d56bc8))
* **main:** 修复记忆自动捕获与列表展示 ([ecfd093](https://github.com/zlh12331/superagent/commit/ecfd093f8a65956a5033764190e413c5a18791fe))
* **main:** 修复路径守卫 realpath 比较不对称致 CI 三平台单测失败 ([8002437](https://github.com/zlh12331/superagent/commit/800243766330972bb1238894120240165058a5c3))
* **main:** 修正 env 索引访问类型，通过 typecheck ([4bb7af1](https://github.com/zlh12331/superagent/commit/4bb7af1463654761576eb1d2f58be8d80eb8786b))
* **main:** 修正函数扫描器对显式返回类型箭头函数的误报，棘轮基线 127→124 ([4401019](https://github.com/zlh12331/superagent/commit/4401019d64564fbdad0bb19e07a8adac1c39dddc))
* **main:** 停用默认模型后对话主链路仍可用 ([2fb5953](https://github.com/zlh12331/superagent/commit/2fb595338ce194218b16bbecdbc69805f8ceb98f))
* **main:** 入参 schema 原样透传 MCP server 的 JSON Schema ([044be19](https://github.com/zlh12331/superagent/commit/044be195a302c33ac258e0c2925fb047fd8b0fb0))
* **main:** 安全加固 + 生命周期收敛 + 事件出口统一 ([7b15233](https://github.com/zlh12331/superagent/commit/7b15233eb381e4406de54df06c301e037f89083f))
* **main:** 对话区模型选择只显示启用的配置模型 ([0360d90](https://github.com/zlh12331/superagent/commit/0360d901185cdedd855e38f60e9aee13f5cf0fab))
* **main:** 恢复 DeepSeek 模型输出上限 384K ([0ffe8f9](https://github.com/zlh12331/superagent/commit/0ffe8f9906937343d5eef878848864553b96bd68))
* **main:** 收敛主题联动到独立模块，修复 IPC 层单测穿透 electron-updater 回归 ([10b732e](https://github.com/zlh12331/superagent/commit/10b732e45329a1bad91cd8d25fab06f91ddbb76e))
* **main:** 文件列表 modifiedAt 浮点取整修复契约校验失败 ([ebd89e6](https://github.com/zlh12331/superagent/commit/ebd89e6476b070301bf6eaeb2d78300944806bf0))
* **main:** 极老库迁移前补齐 runtime_models 缺失列 ([bf63640](https://github.com/zlh12331/superagent/commit/bf63640d4011acfc62cd1e774acd4fb3f540eb5a))
* **main:** 模型输出上限收敛到 API 支持的 64K ([e8ed4d6](https://github.com/zlh12331/superagent/commit/e8ed4d6022037dc83f1a0482d1cc62397acf5aa2))
* **main:** 消除 LLM 调用两层重试相乘并划清分层职责 ([7527564](https://github.com/zlh12331/superagent/commit/75275646cf1d1cbd956e9039b1cfc7f3ce6a3e57))
* **main:** 深度审计修复 - IPC 契约/权限边界/存储与生命周期加固 ([93a938c](https://github.com/zlh12331/superagent/commit/93a938cb80fd3280ab12c0367025358495e9e894))
* **memory-engine:** node_modules 全量提升顶层，修复安装目录间接依赖解析失败 ([#75](https://github.com/zlh12331/superagent/issues/75)) ([68e1471](https://github.com/zlh12331/superagent/commit/68e14714928afd5da1081fa36518df3ba039bd6b))
* **memory-engine:** 打包产物改 dist 转译，修复打包版 sidecar 启动 100% 失败 ([#73](https://github.com/zlh12331/superagent/issues/73)) ([be09ae4](https://github.com/zlh12331/superagent/commit/be09ae49b2143fdbb195dae574c20f0aacecd1bd))
* **memory-engine:** 打包前依赖链接实体化，修复 CD 七链压缩断链失败 ([#79](https://github.com/zlh12331/superagent/issues/79)) ([4d9c485](https://github.com/zlh12331/superagent/commit/4d9c48531451567cb745ca5a833bf02adbf2cb53))
* **memory-hub:** 修复发布链路 P0 打包阻断与集成测试平台可移植性 ([be9e07e](https://github.com/zlh12331/superagent/commit/be9e07e8a0c22347031cf3715eaf868d6e51cde5))
* **memory:** memory:clear 接入上游 /v2/conversation/delete，真实删除会话 L0 ([e552418](https://github.com/zlh12331/superagent/commit/e55241859bc09693f77f61a274f6ec9cc27cbcf5))
* **memory:** 修复引擎子进程从未启动（tsx 注入失效 + pid 竞态误判） ([08942aa](https://github.com/zlh12331/superagent/commit/08942aaedc0229096354b284f52f2fc957dc0102))
* **mock:** add browser-mode mocks for model management IPC ([526cfac](https://github.com/zlh12331/superagent/commit/526cfacde86502ca0377c0fbe6cb12a539fb196c))
* **models:** 模型配置语义闭环——记录驱动 + 调用门禁 + 可空列归一 ([2e8a9d4](https://github.com/zlh12331/superagent/commit/2e8a9d4a64a28cb485b3fc4482048fc7dc114ffb))
* **release:** create 路径用回 GITHUB_TOKEN 避免 update 403 ([#24](https://github.com/zlh12331/superagent/issues/24)) ([79fd051](https://github.com/zlh12331/superagent/commit/79fd0515504e704c41ab632ceb6c03d4ba48c4c8))
* **release:** draft 发布保护+mac 签名自发现修复+beta 分支+watcher 关闭治本 ([6c45eea](https://github.com/zlh12331/superagent/commit/6c45eea091adec5114abf0277469d0080c2f1772))
* **release:** mac 空证书不导出 CSC_LINK + Windows 测试 watcher 走轮询模式 ([5b5b3f6](https://github.com/zlh12331/superagent/commit/5b5b3f64e7dd6933b767339298dc3b0f8e5a8526))
* **release:** publish 改用 release id 查询 draft ([#26](https://github.com/zlh12331/superagent/issues/26)) ([aaa87b9](https://github.com/zlh12331/superagent/commit/aaa87b9e9aed80d7fe8b1fe479171b3761b4a54a))
* **release:** windows 平台裁剪集成测试避免 node-pty/ConPTY worker 崩溃 ([#23](https://github.com/zlh12331/superagent/issues/23)) ([0f81980](https://github.com/zlh12331/superagent/commit/0f81980f699eeee0ac3f86d5c1b90d053d87457a))
* **release:** 修正 draft 查询 jq 表达式，gh api 不支持 --arg ([#27](https://github.com/zlh12331/superagent/issues/27)) ([4affcb7](https://github.com/zlh12331/superagent/commit/4affcb7c1c5b34a8831c5646b7625c3e80c1fcf4))
* **release:** 发布说明润色门禁 + v1.1.1 文案改写为面向用户 ([#45](https://github.com/zlh12331/superagent/issues/45)) ([2c11604](https://github.com/zlh12331/superagent/commit/2c116041c4d161c1f296ab9dc7a582753428665b))
* **release:** 更新既有 release 改用 RELEASE_PLEASE_TOKEN + 修正 body_path 参数名 ([#22](https://github.com/zlh12331/superagent/issues/22)) ([248b127](https://github.com/zlh12331/superagent/commit/248b1270f908f2e7fec91a504ae2a3137ad8f859))
* **renderer:** /models /compact 真实链路并清零 i18n 冗余 key ([921fb12](https://github.com/zlh12331/superagent/commit/921fb1241e727c97234faf75ed2c365386ada307))
* **renderer+scripts:** 修复 typecheck 门禁并加固硬编码审计脚本 ([390f388](https://github.com/zlh12331/superagent/commit/390f3881a182129cb515eeea3cee9f750ea4337e))
* **renderer:** a11y 与 i18n 收口 + 清理死代码 + 门禁度量修正 ([b82db2a](https://github.com/zlh12331/superagent/commit/b82db2ad844637c2fc8e9517537a4988a28ccf98))
* **renderer:** align status bar and dev panel header to 30px ([0f4d27a](https://github.com/zlh12331/superagent/commit/0f4d27a70cc4257e5ddac6484b2a8db010a0e55c))
* **renderer:** composer alignment and message width per annotations ([a6d506e](https://github.com/zlh12331/superagent/commit/a6d506e988baccef4d21473a0f8de1f1df17503f))
* **renderer:** divider, drop step divider, status bar gap ([8b5c27e](https://github.com/zlh12331/superagent/commit/8b5c27e76dedd0eb66b2c9ade6d26113eea610a7))
* **renderer:** eliminate junction lines and widen drag hotzone ([3bc4602](https://github.com/zlh12331/superagent/commit/3bc46029a6c1d0f61387b49f7f4e8647d2820269))
* **renderer:** fade side panels into chat background ([208057d](https://github.com/zlh12331/superagent/commit/208057d96c3e3f4fac47b219e48a74959b5f176c))
* **renderer:** keep resizer divider at 1px width ([6c21b0c](https://github.com/zlh12331/superagent/commit/6c21b0cba4cc6ecec083c9563ae4a1a4f5f7f8c3))
* **renderer:** layout-utils 回退宽度与 aurora 令牌 clamp 对齐 ([f9d9c13](https://github.com/zlh12331/superagent/commit/f9d9c13cbec12b411affffb1137701b4d0e98a32))
* **renderer:** make sidebar dividers invisible by default ([88d30c0](https://github.com/zlh12331/superagent/commit/88d30c0111d1b627f5cb9bacd3480b865358ee77))
* **renderer:** mock 运行时模型状态联动，修复 Web 预览开关无响应 ([e6f0a11](https://github.com/zlh12331/superagent/commit/e6f0a1170aeafad126c6de6b755686c1b18ab6bd))
* **renderer:** optimistic pin cache update for unpin folder return ([ed06f18](https://github.com/zlh12331/superagent/commit/ed06f186d1f2972f49f1ae9186811f2b171b77e5))
* **renderer:** pin ordering by latest pin first ([e345c01](https://github.com/zlh12331/superagent/commit/e345c0129e5ee9c2aa0155d386a1636c2dd15d72))
* **renderer:** rate limit banner close button to far right ([6f938af](https://github.com/zlh12331/superagent/commit/6f938aff1269882fab8afe3d3bde2660bf252a0f))
* **renderer:** rate limit banner single row layout ([410aa94](https://github.com/zlh12331/superagent/commit/410aa942c2154bc606ac7a576157049c7430e014))
* **renderer:** remove crp btn, deepen divider, fix sidebar scrollbar ([c1c5da6](https://github.com/zlh12331/superagent/commit/c1c5da657dd608a708eb01bb8c97a63cdc34eb1f))
* **renderer:** remove hr default 1px border on resizers ([1f4d9bb](https://github.com/zlh12331/superagent/commit/1f4d9bbecc4cacbb45cfe757a7bd1d52ce6cc13a))
* **renderer:** status bar above ambient glow to remove edge seam ([953f7e1](https://github.com/zlh12331/superagent/commit/953f7e142e74a714b30790389d1c07dd7646bfeb))
* **renderer:** swap rate limit banner below approval card ([31beb40](https://github.com/zlh12331/superagent/commit/31beb40467629b8a6327b1c9efb9f8d771bb3b2f))
* **renderer:** swap rate limit banner with thread status bar ([48208e4](https://github.com/zlh12331/superagent/commit/48208e4cae12717b829134f9ece27f1abd3b3ac8))
* **renderer:** terminal duplicate creation and status bar edge gradient ([6b5573d](https://github.com/zlh12331/superagent/commit/6b5573d604fe1cb6273cc831eb5cf0320aa175fc))
* **renderer:** tokenize jump bar styles for project design system ([a6fad1a](https://github.com/zlh12331/superagent/commit/a6fad1addd728de412afc67d065ec6801dab0c48))
* **renderer:** useAgentWithIpc 透传会话 id 给 useChat（内联审批卡根因修复） ([6eaf7b3](https://github.com/zlh12331/superagent/commit/6eaf7b334450e02cbd6aa21b7e71084ff9795626))
* **renderer:** zero resizer gap and remove topbar settings btn ([f66aacc](https://github.com/zlh12331/superagent/commit/f66aacca45275534a4c2b812c1fe55130b328d9c))
* **renderer:** 主题三态统一与版本信息去硬编码 ([f11d3da](https://github.com/zlh12331/superagent/commit/f11d3daafee6f6f1e3775adaf6e3de578333748c))
* **renderer:** 会话重命名时收起操作按钮给输入框让行 ([cedcd5c](https://github.com/zlh12331/superagent/commit/cedcd5c09dda8479fe4b48151ed034a58bb2a20a))
* **renderer:** 保存/删除 API Key 后模型清单即时刷新 ([0583292](https://github.com/zlh12331/superagent/commit/0583292f89f9439734648a545d234ad9dd4f3452))
* **renderer:** 修复 a11y 颜色对比度达标 ([a86821b](https://github.com/zlh12331/superagent/commit/a86821b7b36cb7a6d3ff46196a7d1306c41f99f5))
* **renderer:** 修复 HEAD 遗留 typecheck 错误（设置页崩溃风险） ([d8eecd0](https://github.com/zlh12331/superagent/commit/d8eecd004b19775ed1355316b740154d40e2a42a))
* **renderer:** 删除审批桥接 respondApproval 死代码，纠正 ApprovalDialog 残留注释 ([96ce5e2](https://github.com/zlh12331/superagent/commit/96ce5e26c4e250d85f9f6ef515faf1cc90a6c81b))
* **renderer:** 前端问题清单逐项修复 + 新增 CSS 变量引用门禁 ([674e32e](https://github.com/zlh12331/superagent/commit/674e32e95e6479df01edaf36a9193ff97d6a97fe))
* **renderer:** 右面板 tab 栏改横向滚动修复标签挤压 ([593d83d](https://github.com/zlh12331/superagent/commit/593d83da9367eacbb82a18a3598672e01d987aa2))
* **renderer:** 同步 tokens.css 与 aurora 源，修复 tokens:check 不一致 ([8847e83](https://github.com/zlh12331/superagent/commit/8847e83a1e38441729117c731f753af9b83e184e))
* **renderer:** 命令面板平台修饰键与无障碍细节修复 ([665d0c0](https://github.com/zlh12331/superagent/commit/665d0c0082028ee8c4d4d1777abc9eb47ef5ceb2))
* **renderer:** 审批白名单按类型收敛并补已决回显关闭按钮 ([13e945c](https://github.com/zlh12331/superagent/commit/13e945c404616d5a86352d651c37d7f4ee072b33))
* **renderer:** 审计修复 - usage 孤儿 store 移除/语言纳入 SQLite 真源/迁移原子性 ([5ba0585](https://github.com/zlh12331/superagent/commit/5ba05855d71dcffe0bf232d70401b5fecec79629))
* **renderer:** 对话区模型选择器可见与暂存消息陈旧性防护 ([645525b](https://github.com/zlh12331/superagent/commit/645525bec9cf2e4302df4bae61a4e6ca837916d3))
* **renderer:** 对话页工作目录展示去掉可交互暗示 ([c2ab192](https://github.com/zlh12331/superagent/commit/c2ab192f1143ef5031cecd44876b142e53ccdc80))
* **renderer:** 快捷键帮助对话框改读设置真源消除键位失实 ([10cf77d](https://github.com/zlh12331/superagent/commit/10cf77d665417e5b3f1825c81c784ef23a0e3cc8))
* **renderer:** 思考块折叠态隔离到 part 级，同消息多段思考不再联动 ([2223ef0](https://github.com/zlh12331/superagent/commit/2223ef043fab7f3ba215dd61dfcfc7376e8b11cc))
* **renderer:** 提问进度条改accent填充并补AskDialog测试覆盖 ([3685938](https://github.com/zlh12331/superagent/commit/3685938c7de5909a8b0572e8a5b7a92cdd9cf8b3))
* **renderer:** 文件查看器重复打开同文件不再清空内容 ([a172db5](https://github.com/zlh12331/superagent/commit/a172db52ce1c03b93c4bd9a76fc684e922e86caf))
* **renderer:** 斜杠建议面板改紧凑宽度不再拉伸全宽 ([20048fa](https://github.com/zlh12331/superagent/commit/20048fa20ac35779475e594beaa68e0776f6c348))
* **renderer:** 日志面板工具栏换行与长行横向滚动修复 ([50e4abc](https://github.com/zlh12331/superagent/commit/50e4abc86b6936a725b93d9c4880fe6349851b61))
* **renderer:** 模型配置弹窗修复 - listBuiltin 数据源 + 编辑模式连通性测试用新地址 ([e29179c](https://github.com/zlh12331/superagent/commit/e29179c246a3d9b544cc406d72f981f5027641b8))
* **renderer:** 欢迎页模式与路由同步（任意入口回首页不再隐藏品牌区） ([be027b1](https://github.com/zlh12331/superagent/commit/be027b1746a7c374098ae3af95a48db7ec99d30e))
* **renderer:** 欢迎页首条消息透传接通并补齐文件树节点操作菜单 ([c925d60](https://github.com/zlh12331/superagent/commit/c925d60526dd3d33336aa672a6e31d25361d7f61))
* **renderer:** 消息分页窗口越界裁剪不再渲染空列表 ([310243e](https://github.com/zlh12331/superagent/commit/310243e3614016b5207b6fbca7836251b9fa64c4))
* **renderer:** 消息转换抛错时退订流式监听，修复订阅泄漏 ([ce7267b](https://github.com/zlh12331/superagent/commit/ce7267b1be362128b81e6877df26301897a2a319))
* **renderer:** 消除 folder-label 嵌套交互（axe nested-interactive） ([cc55e53](https://github.com/zlh12331/superagent/commit/cc55e5312318fddbb807d947e9f39443dd946217))
* **renderer:** 消除 render 期读写 ref，修复编译器跳过优化 ([b9ddbae](https://github.com/zlh12331/superagent/commit/b9ddbae4882bd9e222e0d69fcb56dec21d06c65f))
* **renderer:** 消除 thread-item 嵌套交互（axe nested-interactive） ([492b493](https://github.com/zlh12331/superagent/commit/492b49301941a0997ffa6b6aad9e890e85eee216))
* **renderer:** 消除全部 try/finally 以适配 React Compiler（10 处等价改写） ([455c476](https://github.com/zlh12331/superagent/commit/455c476250462efceff04b570d161bbf39acf73a))
* **renderer:** 渲染层全域审计收口——17 项缺陷修复 + 3 项新门禁 + 视觉回归门禁修复 ([#44](https://github.com/zlh12331/superagent/issues/44)) ([b7a075c](https://github.com/zlh12331/superagent/commit/b7a075c70a6b599d9b42c96a7d79faa653868dc8))
* **renderer:** 渲染层设计审计全量修复(对比度根治+四态补齐+z收口) ([2613cd6](https://github.com/zlh12331/superagent/commit/2613cd6d63e7997b39066096aed23c231cc35954))
* **renderer:** 焦点环覆盖链接元素 ([d49fd37](https://github.com/zlh12331/superagent/commit/d49fd3756509d98b612a8de4fd7e32e5800c8851))
* **renderer:** 状态管理一致性 + 终端缓冲修复 + diff 口径统一 ([a64e5b7](https://github.com/zlh12331/superagent/commit/a64e5b7e56236b00a9c944141934402f9ef39f3c))
* **renderer:** 移除左右侧边栏镜像渐变，改纯底色 ([065f42d](https://github.com/zlh12331/superagent/commit/065f42dd196df4f8d81ede15c9b116dd379a080a))
* **renderer:** 移除添加模型弹窗重复的关闭按钮 ([11fad42](https://github.com/zlh12331/superagent/commit/11fad4213b0ce487c9cc5f90999ffb44d96bb78c))
* **renderer:** 统一键盘焦点环（accent outline 全交互元素） ([0533acc](https://github.com/zlh12331/superagent/commit/0533acc5bdfa4f923ce44e52a8fba8974ffc0148))
* **renderer:** 编辑模型时锁定 modelId 主键，文档同步实现状态 ([19ca441](https://github.com/zlh12331/superagent/commit/19ca44152b5f42be6a6df36d2328050303f018e5))
* **renderer:** 聊天区布局对齐（消息列/用户气泡/项目栏/导航轨） ([4c6c392](https://github.com/zlh12331/superagent/commit/4c6c39204c0bf26a6230deddc68eafbc9b3bc1ce))
* **renderer:** 补渲染层 Sentry 初始化，消除错误事件静默丢弃 ([859d471](https://github.com/zlh12331/superagent/commit/859d4714a4d1fd0fd786fb3022bc18d5ef31d9a3))
* **renderer:** 补齐 MCP 错误渲染与设置分区错误重置等交互缺口 ([bf7a19e](https://github.com/zlh12331/superagent/commit/bf7a19e51028c4e1a33dfba3b903855f1dd35a90))
* **renderer:** 补齐乐观更新回滚、缓存失效与静默失败提示 ([2cb8075](https://github.com/zlh12331/superagent/commit/2cb8075143c3b6471cfbabc8662cb012421973e6))
* **renderer:** 裸色硬编码迁移语义令牌并归一尺寸双写 ([8c28bd0](https://github.com/zlh12331/superagent/commit/8c28bd0ea40fd445585da44355004c7bfab6df99))
* **renderer:** 输入舱 vim 光标落点 effect 依赖收敛 ([af3585e](https://github.com/zlh12331/superagent/commit/af3585e1c8ebfffdb44a880050372fdad4dc8254))
* **renderer:** 错误本地化统一 + 文件树刷新失败反馈 + 注释与实现对齐 ([462d349](https://github.com/zlh12331/superagent/commit/462d3490be9e23b73e4406042822c0d20b4ac261))
* **scripts:** check-csp-hash 脚本提取锚定 head 并剥离 HTML 注释，封死注释旧脚本静默放行路径 ([d9d42e5](https://github.com/zlh12331/superagent/commit/d9d42e574cbddc559c6e7260ac327e4e509ad404))
* **scripts:** commitlint scope 枚举剔除已删除的 prisma/pg/rag 层 ([366d1e6](https://github.com/zlh12331/superagent/commit/366d1e65bf1b5c2894512d815e59121dfac5225b))
* **scripts:** toPosixRelative 用例按平台分隔符输入，POSIX 下不再误判 ([78031ff](https://github.com/zlh12331/superagent/commit/78031ffa969e7a63345209e8b2884adb657c22f2))
* **scripts:** 三处门禁形同虚设修复（函数度量/depcruise/schema 漂移） ([cc191f6](https://github.com/zlh12331/superagent/commit/cc191f6fd218e58568f6938eab09448437e3e394))
* **scripts:** 修 check-native-arch 的 macOS 路径缺陷 + 0 检查数改为失败 ([#59](https://github.com/zlh12331/superagent/issues/59)) ([9701992](https://github.com/zlh12331/superagent/commit/9701992d2ab3237dbbfe3068db8190190a21df61))
* **scripts:** 修复 memory-hub 打包资源生成 ([09ee659](https://github.com/zlh12331/superagent/commit/09ee65965744282dee372beef8e6517acd271154))
* **scripts:** 文件体积门禁改为净行卡关 + 原始行仅告警（与规范规则 9.2 对齐） ([96dc556](https://github.com/zlh12331/superagent/commit/96dc556245674026a08c9e323f50f5f6c4ee3fee))
* **scripts:** 棘轮口径对齐 + ui-consistency 复用公共棘轮 ([9291715](https://github.com/zlh12331/superagent/commit/9291715c159e3c5e954b5a53b7ac9024f5f7fc6d))
* **scripts:** 棘轮只锁超限维度 + 规范目标差距可视化 + 未知指标报错 ([80d7f28](https://github.com/zlh12331/superagent/commit/80d7f28fef2604ab41064c15d1bbf2d1b0cc0b02))
* **scripts:** 清理 memory-hub 重型依赖时一并摘除断链 junction ([d8b74a1](https://github.com/zlh12331/superagent/commit/d8b74a117fecc088e73066ef53d4fdf0e6229369))
* **security:** pnpm overrides 修复 22 个传递依赖漏洞 ([b9aa605](https://github.com/zlh12331/superagent/commit/b9aa6051014167f111affec60f13daba5463060b))
* **security:** web_fetch SSRF 防护 + 命令通道 symlink 越界 + plan 模式短路修复 ([0ba731b](https://github.com/zlh12331/superagent/commit/0ba731bf3873238bc96f503a0cd55547cd55aa33))
* **security:** 修复参数注入/密钥外泄/路径逃逸等 8 项深度防御缺口 ([23e9c9f](https://github.com/zlh12331/superagent/commit/23e9c9f2289fc6fbc0a7e9544921eac402b626b1))
* **security:** 修复四条静态扫描告警（实体双重解码/标签变体/注释残留/明文落盘） ([09ce70c](https://github.com/zlh12331/superagent/commit/09ce70c2a595901da0c66e97e8a2f6afea66ecec))
* **security:** 修复路径越权/命令绕过/IM 群聊未授权执行 ([29fac36](https://github.com/zlh12331/superagent/commit/29fac36ce84942a3bc99c0b9f96d87aa63073819))
* **security:** 安全/性能审计修复（符号链接逃逸+黑名单+输出可见性） ([f9e1b8c](https://github.com/zlh12331/superagent/commit/f9e1b8ca718ee7c6d9467d58fbe1b1a38808b1c0))
* **security:** 权限 auto 快速路径补工作目录边界校验 + 审批超时通知决议 ([456c4d8](https://github.com/zlh12331/superagent/commit/456c4d81105549d26dbfb617bcea25647a562923))
* **settings:** 打破 model-config-dialog 与 fields 循环依赖 ([01fd5f4](https://github.com/zlh12331/superagent/commit/01fd5f48abdcb3543746eb399b955d3b66619f87))
* **shared:** 契约校验全量闭环 + schema 加固 ([f1e5bfd](https://github.com/zlh12331/superagent/commit/f1e5bfda5ef7930605fda30f3e9fd29d7c91b272))
* **shared:** 审批"记住"按钮明示有效期，TTL 常量收敛单一真源 ([c94b8b5](https://github.com/zlh12331/superagent/commit/c94b8b593cab7bc0f2ee53c471f0bd022774db6e))
* **shared:** 新增 settings:getAll/set 契约（设置下沉 SQLite） ([796331c](https://github.com/zlh12331/superagent/commit/796331cf76185e81d48c242eddd891e156e3c6a0))
* **shared:** 补全统一入口缺失的 schema 导出，对齐 main/renderer ([18842ad](https://github.com/zlh12331/superagent/commit/18842ad02f105a4fa6ff90089695bfa136453fb7))
* **storage:** 会话删除后归还 SQLite 磁盘空间，freelist 页按需回收 ([a5a16f4](https://github.com/zlh12331/superagent/commit/a5a16f46f0bebcbb2712d6f7d0205926f5828190))
* **storage:** 关闭连接前等待在途启动备份落地，杜绝截断备份成为假恢复点 ([098ddc3](https://github.com/zlh12331/superagent/commit/098ddc346aa37d1a80d68908cb8a79616c3bb5ed))
* **storage:** 启动自愈先于 VACUUM + 备份移到迁移后 + keychain 原子写 + 索引修正 ([ba556ed](https://github.com/zlh12331/superagent/commit/ba556ed17340c38a2c58c688537149f3b853d62f))
* **storage:** 完整性校验失败的库跳过启动备份，保护既有健康恢复点 ([ff41931](https://github.com/zlh12331/superagent/commit/ff41931c669d7854ec26b8ed14f79ea8dc19ab5e))
* **styles:** define missing z-index tokens for modal overlay ([5cc1223](https://github.com/zlh12331/superagent/commit/5cc12233ef28fb12c4beb71d87b62877b77a4968))
* **telemetry:** otel shutdown 改用 provider 实例引用确保 flush 生效 ([4dd14c3](https://github.com/zlh12331/superagent/commit/4dd14c374baff5a603431cc5945e0d85834f9946))
* **telemetry:** 修复事件循环延迟监控空闲误报——基准按期望间隔推进 ([8e5b470](https://github.com/zlh12331/superagent/commit/8e5b470a16865da4becc993d53bb8da674a3a149))
* **telemetry:** 打包版未配置 OTLP 端点时不再落 Console exporter ([2e9b04e](https://github.com/zlh12331/superagent/commit/2e9b04e02ee735a446bf0b08e8a8b021a05998fe))
* **terminal:** 已退出终端输出缓冲按 FIFO 上限淘汰 ([9aee3ce](https://github.com/zlh12331/superagent/commit/9aee3cedabc1bb9f73d8e5a51c6ad5e3bb615964))
* **test:** grep 路径断言按平台计算，规避盘符路径在 POSIX 下的误判 ([1b19efb](https://github.com/zlh12331/superagent/commit/1b19efba763d4e3f05a37c00d204e800e7feb9e3))
* **test:** sdk-telemetry 测试 mock 补全 Tracer 类型（typecheck 门禁） ([39538fa](https://github.com/zlh12331/superagent/commit/39538facf7c96b6406d6391936318b019308e7a0))
* **test:** 修复 coverage 插桩下两个上下文压缩用例超时 + 基线同步 ([01b3155](https://github.com/zlh12331/superagent/commit/01b3155297270d6e70b9165e3d069e578ba05c17))
* **tokens:** restore bg-elev token definitions ([6f90569](https://github.com/zlh12331/superagent/commit/6f90569719b970d959d3122bd71b75b60ccccab9))
* **tools:** run_command 超时/中断改进程树终止防管道悬挂 ([c3a6160](https://github.com/zlh12331/superagent/commit/c3a6160bbdc6ba634bde29ea6d466df92caf64ae))
* **types:** adapt ai sdk upgrade type changes ([71ad0eb](https://github.com/zlh12331/superagent/commit/71ad0ebd07265dad27dc1e8e13605a41711f5e02))
* **update:** 修复 Windows 1.3.1→1.3.2 升级失败（NSIS 长路径） ([#61](https://github.com/zlh12331/superagent/issues/61)) ([66290dc](https://github.com/zlh12331/superagent/commit/66290dcca4f1988a019d64196ab63d083fa7d426))
* **update:** 更新安装改两段式，消除无法关闭弹窗竞态 ([#49](https://github.com/zlh12331/superagent/issues/49)) ([af30b52](https://github.com/zlh12331/superagent/commit/af30b52bc869afff301301c206674251bcf3e07d))
* **update:** 真机三问题取证修复——差分基准一致性 + 退出后安装生效 ([#54](https://github.com/zlh12331/superagent/issues/54)) ([836e8b0](https://github.com/zlh12331/superagent/commit/836e8b095a183ab854af28b7bc5e924600fdac71))
* 修复 agent 内核/安全边界/存储层缺陷并补齐静态门禁 ([828c587](https://github.com/zlh12331/superagent/commit/828c5873ac9717bb34cb29658deeeca5a4c7af57))
* 修复 nsis 安装器图标配置，png 图标导致 windows 打包失败 ([acc2fed](https://github.com/zlh12331/superagent/commit/acc2fede079625d7060f7b4ab21663c10ac733c9))
* 修复静态审计脚本规则盲区与失效判定 ([6af5363](https://github.com/zlh12331/superagent/commit/6af5363c4a50590c5881b015c30020eaf85b68b6))
* 安装速度深度优化（引擎 bundle 单文件化）+ 更新日志 Markdown 渲染 + 就绪超时放宽 ([e02853c](https://github.com/zlh12331/superagent/commit/e02853ce7a3858bf549cb68b3d091bd3daf7ce96))


### Performance Improvements

* **main:** token 计数缓存 + 异步日志 + 工具输出闸门 + 补齐热查询索引 ([3194eac](https://github.com/zlh12331/superagent/commit/3194eace7c471043a1dc253270ca285f2ff1a57e))
* **main:** 流式通道补输出闸门 + memory-hub 异步 IO + 用量 SQL 下推 + 终端字节计数 ([373f2bb](https://github.com/zlh12331/superagent/commit/373f2bbcbf8b27b380787b45911787c5dfc04070))
* **main:** 编码检测只采样头部 64KB，2MB 文件读取 24s→441ms ([3c11f37](https://github.com/zlh12331/superagent/commit/3c11f37d11c72aa33cb8026924e4ad89aba74483))
* **renderer:** 流式自动滚动瞬时化 + 滚动事件 rAF 合帧 ([5f479de](https://github.com/zlh12331/superagent/commit/5f479de55defe7544d321eab89d0797fe1755a3c))
* **renderer:** 浮层与右面板懒加载拆分首屏 chunk 并补分隔线键盘调整 ([d9796ec](https://github.com/zlh12331/superagent/commit/d9796ecaf458a0291ff2e68b369886daaec8d700))


### Miscellaneous Chores

* **release:** 收口发布流水线并重置版本基线以发 v1.0.0 ([#29](https://github.com/zlh12331/superagent/issues/29)) ([e243606](https://github.com/zlh12331/superagent/commit/e243606938d862504bf8ef923a32197e97999586))

## [1.6.0-beta.3](https://github.com/zlh12331/superagent/compare/v1.6.0-beta.2...v1.6.0-beta.3) (2026-10-05)

> ⚠️ **预发布版本（beta）**：本版是 beta.2 真机反馈的提速闭环——**应用内升级耗时大幅缩短**、引擎冷启动加速、关于面板更新日志改为结构化展示。从 beta.2 升级后请实际体验并向我们反馈。

### 修复

- **升级安装提速**：记忆引擎运行目录改为单文件产物（282.8MB / 7078 个文件 → **35.6MB / 180 个文件**），升级安装耗时预期从约 17 分钟回落到 **2-4 分钟**量级；引擎冷启动（首次加载）同步大幅加速（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **关于面板更新日志可读**：更新日志按标题、列表、链接等结构化排版展示，不再出现原始 Markdown 符号（[#77](https://github.com/zlh12331/superagent/issues/77)）
- **引擎启动等待放宽**：安装后首次冷启动（机械盘 + 杀软逐文件扫描场景）的就绪等待由 20 秒放宽至 60 秒，消除刚升级后记忆功能「健康检查未通过」的误报；打包内容剔除冗余的第二份依赖实体，安装写入量减半（[#77](https://github.com/zlh12331/superagent/issues/77)）

### 内部改进

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
