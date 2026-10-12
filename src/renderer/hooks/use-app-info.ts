import type { AppInfoRes } from '@code-agent/shared/renderer';
import { useEffect, useState } from 'react';
import { unwrap } from '@/lib/ipc';
import { useLatestRef } from './use-latest-ref';

/**
 * 拉取应用信息（挂载后一次性；浏览器模式 / IPC 失败时返回 null，调用方自兜底）
 *
 * @param onError 可选失败回调（about-section 需要 toast 告知用户；不传则静默返回 null）。
 *   经 ref 持有，不参与 effect 依赖——调用方无需为其加 useCallback 稳定引用。
 * @returns AppInfoRes | null（null = 尚未返回或失败，展示占位）
 */
export function useAppInfo(onError?: (error: unknown) => void): AppInfoRes | null {
  const [info, setInfo] = useState<AppInfoRes | null>(null);
  const onErrorRef = useLatestRef(onError);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.api : undefined;
    const getInfo = api?.app?.getInfo;
    if (typeof getInfo !== 'function') {
      setInfo({
        version: 'dev',
        electron: '-',
        node: '-',
        chrome: '-',
        platform: typeof api === 'undefined' ? 'browser' : 'test',
        arch: '-',
        userDataPath: '-',
      });
      return undefined;
    }
    getInfo()
      .then((res) => {
        if (cancelled) return;
        try {
          setInfo(unwrap(res));
        } catch (error: unknown) {
          setInfo(null);
          onErrorRef.current?.(error);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInfo(null);
          onErrorRef.current?.(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
