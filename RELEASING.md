# 发布手册（RELEASING）

本仓库采用 **release-please + 单发布分支（main）** 的发布模型。本文是发版的完整操作手册。

## 一、核心模型

| 环节 | 负责 | 说明 |
|---|---|---|
| 版本号推导 | release-please | 读 Conventional Commits 算下一个版本，写入 `.release-please-manifest.json` + `package.json` |
| CHANGELOG | release-please | 自动生成；**发版前在 Release PR 中人工润色为面向用户的文案** |
| 打 tag | release.yml | 三平台构建成功 **且** 独立 CI 全绿后才打 tag（防空版本占号） |
| 对外可见 | release.yml `publish` job | 校验三平台安装包 + `latest*.yml` 齐全后，draft 才转正式 |

**只有 main 一条发布分支。** 预发布（beta）不靠分支实现，靠版本号后缀 + `Release-As`。

版本号推导配置见 `release-please-config.json`：

```json
{
  "versioning": "prerelease",
  "prerelease-type": "beta"
}
```

> ⚠️ release-please **不会按分支名自动识别 prerelease**。配置文件从「被发布分支的 tip」读取，
> 所以 prerelease 行为完全由上面两行决定，与分支叫什么名字无关。
>
> `versioning: "prerelease"` 且未开 `prerelease` 时：稳定版推导与默认策略**完全一致**，
> 唯一区别是会把 `X.Y.Z-beta.N` 收敛为干净的 `X.Y.Z`（这是"毕业"机制）。

## 二、发正式版（常规流程）

1. 功能开发走 PR 合入 main（Conventional Commits；main 受 ruleset 保护，需 PR + 11 项检查 + 线性历史）
2. release-please 自动开/更新 Release PR，标题形如 `chore(main): release 1.1.0`
3. 审阅该 PR：版本号是否符合预期、在 PR 里润色 CHANGELOG
4. 合并 Release PR → 触发 `release.yml`
5. `release.yml` 依次：gate 识别发布提交 → 三平台构建（与 ci-check 并行）→ 打 tag + 建 draft → 校验资产 → 转正式
6. 自动更新源（`latest*.yml`）随资产一起发布

> 想控制发版节奏，就**先不合并 Release PR**——提交会一直累积进下一个版本。这是天然的发版节流阀。

## 三、发 beta（预发布）

在推给 main 的提交里加 footer：

```
feat(ui): 某个新功能

Release-As: 1.1.0-beta.1
```

- release-please 会开 `chore(main): release 1.1.0-beta.1` 的 PR
- 合并后 `release.yml` 按版本含 `-` 自动标记为 GitHub **Prerelease**（同时打 tag `v1.1.0-beta.1`）
- 继续发下一个 beta：再写 `Release-As: 1.1.0-beta.2`

beta 与正式版共用 `latest*.yml` 更新源；已装 beta 版的应用（版本含 `-beta`）会自动开启预发布更新检查，
稳定版用户**不会**收到 prerelease（GitHub `/releases/latest` 天然跳过 prerelease）。

## 四、从 beta 毕业为正式版

`1.1.0-beta.N` 之后，**普通提交即可**（不加 `Release-As`）：

- prerelease 策略在 `prerelease` 未开启时，会把 `1.1.0-beta.N` 收敛为 `1.1.0`
- 也可显式指定：`Release-As: 1.1.0`

## 五、发版失败后重试

任一环节失败 → 无 tag、无 Release、版本号不占号，可直接重试：

- 本地修复后 push，或
- 手动重放 CD：`workflow_dispatch` 触发 Release workflow，`confirm_version` 必须填**与 `package.json` 当前版本一致**的版本号，否则 gate 拒绝

## 六、热修复（待需要时启用）

若已发布的 `1.0.0` 爆出严重 bug，而 main 已累积了 1.1.0 的功能，需要出只含该修复的 `1.0.1`：

1. 从 tag `v1.0.0` 切维护分支 `release/1.0`
2. 在该分支 cherry-pick 修复提交
3. 该分支需要自己的 manifest 配置（`versioning: "always-bump-patch"`）与 workflow 触发分支
4. 单独发版

> 当前尚未启用。等真有 parallel 维护需求时再落地，不要提前复杂化。

## 七、常见坑

| 现象 | 原因 |
|---|---|
| 合并 Release PR 后没打 tag | 旧版曾用非法的 `skip-tag` 输入（被 Actions 静默忽略）；现用 `skip-github-release: true`，tag 一律由 `release.yml` 创建 |
| 更新 Release 报 403 | softprops 对**已存在**的 release 做 update 会被拒；正常路径是 create（用 `GITHUB_TOKEN`）。重放已存在 tag 的场景改用 `gh` CLI 手动处理 |
| 三平台构建成功但未发布 | `publish` job 校验资产未通过（缺安装包或 `latest*.yml`），Release 保持 draft |
