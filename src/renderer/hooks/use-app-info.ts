// src/renderer/hooks/use-app-info.ts
// 应用版本/环境信息 hook（app:getInfo IPC 统一入口）
// ──────────────────────────────────────────────────────────────
// 背景：Topbar brand-telemetry 与侧栏账户菜单此前硬编码 'v0.1.0'，
// 与 about-section 的 app:getInfo 三处双写；版本升级后前两处必然失实。
// 统一走主进程 package.json version（单一真源）。
// ──────────────────────────────────────────────────────────────

import type { AppInfoRes } from '@code-agent/shared/renderer';
import { useEffect, useState } from 'react';

import { unwrap } from '@/lib/ipc';

/**
 * 拉取应用信息（挂载后一次性；浏览器模式 / IPC 失败时返回 null，调用方自兜底）
 *
 * @returns AppInfoRes | null（null = 尚未返回或失败，展示占位）
 */
export function useAppInfo(): AppInfoRes | null {
  const [info, setInfo] = useState<AppInfoRes | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.api : undefined;
    // 防御：浏览器模式（无主进程）或测试环境 mock 未注入 app.getInfo 时返回占位。
    // 必须先取方法引用再判断——直接调用不存在的方法会同步抛错，无法被 .catch 捕获
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
        } catch {
          // error 响应 / 协议异常：与 IPC 失败同策略（调用方自兜底占位）
          setInfo(null);
        }
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
