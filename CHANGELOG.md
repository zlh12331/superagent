# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
