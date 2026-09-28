// src/renderer/hooks/use-latest-ref.ts
// latest-ref 惯用法统一实现
// ──────────────────────────────────────────────────────────────
// 背景：window/document 监听或低频 effect 需要「调用最新闭包」但不想因函数
// 身份重订阅。此前三种写法在仓库并存，其中两处把 ref 写在渲染期——
// React 并发渲染禁止：render 可能被丢弃，ref 会持被弃渲染的闭包；且含
// 渲染期 ref 写的组件会被 React Compiler 判违规、跳出自动记忆化
// （2026-09-28 深读发现，ChatMessageList/ChatInput/ModelSelector 三处收敛）。
//
// 本 hook 把写入收敛到 effect 阶段（渲染提交后、用户事件前执行）。
//
// ⚠️ 顺序前提：同组件的 effect 按声明序执行——消费 effect 必须声明在
// useLatestRef 调用之后，保证执行时 ref 已更新为最新闭包
// （先例：FileViewerPanel saveHandlerRef，2026-09-28 收敛为共享 hook）。
// ──────────────────────────────────────────────────────────────

import { type RefObject, useEffect, useRef } from 'react';

/**
 * 返回持有 value 最新引用的 ref（写入发生在 effect 阶段，非渲染期）
 *
 * @param value 每次渲染传入的最新闭包/值
 * @returns ref（消费方在监听回调 / 后续 effect 中读取 ref.current）
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
