/**
 * Remote feature — 远程控制视图
 *
 * 对齐 prototype.html §2.17 Remote 视图。
 * 提供远程控制开关、配对码展示、已配对客户端管理与协作模式。
 *
 * 当前为实验性功能（experimental），后端 Tauri 命令尚未实现，
 * 使用浏览器 mock 模式运行（与原型一致）。
 *
 * @see prototype.html L14562-14644 — renderRemote 函数
 */

export { RemoteView } from './RemoteView'
export { useRemoteStore } from './remote-store'
export type {
  RemoteControlStatus,
  RemoteControlClient,
  RemoteStoreState,
} from './remote-store'
