/**
 * layout barrel — 仅导出布局编排组件
 *
 * 设计原则：components/layout/ 只保留纯布局壳，
 * 业务组件通过 features/ 目录引用。
 */

export { MainWindow } from './MainWindow'
export { TitleBar } from '../titlebar/TitleBar'
export { MacOSWindowControls } from '../titlebar/MacOSWindowControls'
