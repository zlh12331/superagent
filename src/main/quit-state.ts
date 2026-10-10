let closeConfirmed = false;

/** 用户是否已确认退出（关窗协商通过后置位） */
export function isCloseConfirmed(): boolean {
  return closeConfirmed;
}

/** 标记用户已确认退出（协商弹窗"退出"按钮回调；更新安装入口在渲染层确认后亦置位） */
export function setCloseConfirmed(): void {
  closeConfirmed = true;
}

let quitting = false;

/** 退出流程是否已开始（before-quit 置位后为 true） */
export function isQuitting(): boolean {
  return quitting;
}

/** 标记退出流程开始（index.ts before-quit 善后前置位） */
export function setQuitting(): void {
  quitting = true;
}

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
