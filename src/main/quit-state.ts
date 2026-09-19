// src/main/quit-state.ts
// 退出协商共享状态（进程与窗口维度）
// ──────────────────────────────────────────────────────────────
// close 路径（Windows/Linux 点 X）与 before-quit 进程级路径（macOS Cmd+Q /
// app.quit()）共享同一个"用户已确认"标志：任一路径确认后，另一路径直接放行。
// macOS Cmd+Q 不触发窗口 close 事件（before-quit 先行），因此标志必须模块级。
//
// 独立成模块的原因：更新安装（quit-for-update）也需要置位该标志以跳过重复
// 确认——若放在 window.ts，会形成 update-service → window → service-container
// 的循环依赖。
// ──────────────────────────────────────────────────────────────

let closeConfirmed = false;

/** 用户是否已确认退出（关窗协商通过后置位） */
export function isCloseConfirmed(): boolean {
  return closeConfirmed;
}

/** 标记用户已确认退出（协商弹窗"退出"按钮回调；更新安装入口在渲染层确认后亦置位） */
export function setCloseConfirmed(): void {
  closeConfirmed = true;
}

// ── 退出进行中标志 ──
// before-quit 与窗口 close 处理器分属两个文件，退出链中窗口 close 事件需要
// 区分"用户点 X"与"退出流程中的窗口销毁"（后者放行，不做最小化劫持）。
let quitting = false;

/** 退出流程是否已开始（before-quit 置位后为 true） */
export function isQuitting(): boolean {
  return quitting;
}

/** 标记退出流程开始（index.ts before-quit 善后前置位） */
export function setQuitting(): void {
  quitting = true;
}

// ── 退出后安装挂起标志（Windows 两段式安装）──
// 为什么必须模块级而非 UpdateService 实例字段：退出链末端（index.ts）在
// disposeServices() 之后才调用 getUpdateService()，而容器 dispose 会把
// updateService 引用置空——此后取出的是惰性新建的实例，实例字段上的挂起标志
// 恒为 false，安装会被静默吞掉（2026-09-19 实测：点「重启并安装」应用退出但
// 安装器从未拉起，用户侧表现为安装失败）。
let deferredInstallPending = false;

/** 标记「用户已请求退出后静默安装」（UpdateService.quitAndInstall 置位） */
export function requestDeferredInstall(): void {
  deferredInstallPending = true;
}

/** 是否有待执行的退出后静默安装 */
export function isDeferredInstallPending(): boolean {
  return deferredInstallPending;
}

/** 清除挂起标志（拉起安装器时调用；测试清理亦用） */
export function clearDeferredInstall(): void {
  deferredInstallPending = false;
}
