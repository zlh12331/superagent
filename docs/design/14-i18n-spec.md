# 14. i18n 国际化规范

> 基于项目实际 i18n 体系（i18next + react-i18next，中英双语，480+ key 零缺失审计）制定约定。
> 最后同步：2026-08-11

---
> 🔒 工程化强制：pnpm check:i18n（缺失卡关 + 冗余 --strict 卡关，pre-push + CI 执行）

## 一、文件结构

```
src/renderer/i18n/
├── config.ts              # i18next 初始化（语言检测/回退/插值）
├── I18nProvider.tsx       # 根 Provider（挂 AppProviders）
├── index.ts               # 出口（i18n 实例 + 类型）
├── use-translation.ts     # useTranslation 包装（类型安全 t）
└── locales/
    ├── en/
    │   ├── common.json    # UI 文案
    │   └── errors.json    # 错误消息（AppError code → 文案）
    └── zh-CN/
        ├── common.json
        └── errors.json
```

- **双语言文件结构必须完全一致**（key 集合相同），新增 key 必须同时补 en + zh-CN
- 错误码文案集中 `errors.json`，UI 按 `AppError.code` 查表（无匹配时显示原始 message）

## 二、key 命名规范

```
格式：<域>.<组件|场景>.<语义>
示例：
  chat.fileChange.created     （聊天域 · 文件变更卡 · 已创建）
  settings.providerConfigured（设置域 · 提供商 · 已配置）
  approval.runCommand         （审批域 · 类型标签）
  common.close                （通用 · 关闭）
```

1. **域前缀**：chat / agent(approval) / settings / common / panel / terminal / git / file-tree / shortcut 等（与组件域目录对齐）
2. **语义后缀**：动词过去式（created/removed）或状态（running/stopped）、名词（title/hint/empty）
3. **禁止**：key 内嵌动态值（用插值 `{{name}}`）、中文/拼音 key、编号 key（`key1/key2`）
4. **插值**：`t('chat.fileChange.count', { count })`，复数用 i18next 复数规则（en 需要，zh 可忽略）

## 三、新增文案流程

1. 在组件中先用 `t('域.语义')` 占位（use-translation 的 t 有类型约束，未声明 key 会类型报错）
2. 在 `zh-CN/common.json` 与 `en/common.json` 同时添加 key（结构一致）
3. 运行 i18n 审计脚本核对无缺失/多余（当前基线：602 引用 0 缺失）
4. 不可翻译文案（路径/代码/命令）不进语言包，直接在 JSX 硬编码

## 四、验证

- **类型安全**：`use-translation.ts` 的 t 基于语言包扁平 key 推导（`useTranslation` 泛型），未定义 key 编译期报错
- **审计脚本**：对比 `t('...')` 引用集合与语言包 key 集合（双向：引用缺失 + 未引用冗余）
- 抽查：切语言（设置 → 语言）后无 key 原文泄漏（显示 `xxx.yyy` 即缺失）

## 五、检查清单

- [ ] key 命名合规（域.组件.语义）
- [ ] en + zh-CN 同步添加
- [ ] 动态内容用插值，非拼接
- [ ] 错误消息走 errors.json（按 code）
- [ ] 审计脚本通过

> **工具评估（2026-08-11）**：调研 i18next-cli（官方 SWC 工具）/ i18next-parser 后**未引入**——原因：①其输出格式与项目语言包 `{translation:...}` 顶层包装结构不兼容（extract 会重建文件）；②AST 提取的"新 key"实为命名空间错位误报（key 已在语言包）；③check:i18n（正则+类型安全 t）已验证 0 缺失。结论：保留自研 check:i18n，新增 key 走 §三流程。

> **工具落地（2026-08-11，方案 1：开发辅助）**：引入 `i18next-cli`（官方 SWC 工具）作为**只读辅助**（不写语言包、不接门禁）：
> - `pnpm i18n:lint`——硬编码字符串检测（AST 启发式），首跑 **48 个漏翻候选**（品牌名/版本号/装饰文案属合理硬编码，需人工审阅分类）——这是 check:i18n 不具备的能力（漏翻审计）
> - `pnpm i18n:status`——翻译健康报告；**注意**：因语言包 `{translation:...}` 顶层包装，i18next-cli 读不到 key（报告全缺失失真），待语言包扁平化（方案 3）后才准确
> - **方案 2 触发条件**（不预置）：项目开始使用 `keyPrefix`/别名 t 时升级（AST 能力才有真实命中；代价=9 处动态 key 注释声明两处维护）；当前 0 处 keyPrefix/别名用法，check:i18n + 类型安全 t 已双层覆盖
