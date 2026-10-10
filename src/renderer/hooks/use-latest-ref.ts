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
