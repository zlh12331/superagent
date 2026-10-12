// quit-state.ts：退出协商状态位（模块级三组标志）——关窗确认 / 退出善后进行中 / 延迟安装
// 供 window.ts 关窗协商与 index.ts before-quit 善后链跨模块共享；只存标志不做副作用，随应用生命周期存续
let closeConfirmed = false;

/** 用户是否已确认退出（关窗协商通过后置位；SIGINT/SIGTERM 视同已确认） */
export function isCloseConfirmed(): boolean {
  return closeConfirmed;
}

/** 标记用户已确认退出（协商弹窗「退出」回调置位；更新安装入口在渲染层确认后亦置位） */
export function setCloseConfirmed(): void {
  closeConfirmed = true;
}

let quitting = false;

/** 是否已进入退出善后（before-quit 第二段），防止 dispose 链被后续退出事件重入 */
export function isQuitting(): boolean {
  return quitting;
}

/** 标记退出善后开始（调用后 before-quit 首行早退，协商不再触发） */
export function setQuitting(): void {
  quitting = true;
}

let deferredInstallPending = false;

/** 请求延迟安装更新：quitAndInstall 时机不成熟（如托盘路径）时由 update-service 置位 */
export function requestDeferredInstall(): void {
  deferredInstallPending = true;
}

/** 延迟安装是否待执行（before-quit 善后收尾时据此调用 runDeferredInstall） */
export function isDeferredInstallPending(): boolean {
  return deferredInstallPending;
}

/** 消费延迟安装请求（update-service 执行 quitAndInstall 前清除，防重复安装） */
export function clearDeferredInstall(): void {
  deferredInstallPending = false;
}
