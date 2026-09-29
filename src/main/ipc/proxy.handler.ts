// src/main/ipc/proxy.handler.ts
// Proxy 域 IPC handler（proxy:test 测试连接，34 号网络代理 §2.3）
// ──────────────────────────────────────────────────────────────
// D7（真·探测）：经 proxiedFetch 访问轻量端点，3s 超时；405 等非网络错误
// 也算「通」（目标存在即可，不要求 2xx——generate_204 类端点未必处处可达）。
// 归因（反例 6）：连代理失败 → proxy-unreachable；代理通但目标失败 →
// target-unreachable。mode 非 fixed 时 not-applicable（无可测对象）。
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { proxiedFetch, setProxyFetchConfig } from '../infra/network/proxied-fetch';
import { parseProxyConfig } from '../infra/network/proxy-resolver';
import { readSetting } from '../infra/storage/settings-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/** 探测超时（毫秒，D7） */
const PROBE_TIMEOUT_MS = 3_000;
/** 中立探测端点（CP2 #12：不锚定 AI 供应商域名；204 端点轻量无副作用） */
const DEFAULT_PROBE_TARGET = 'https://www.gstatic.com/generate_204';

/**
 * Proxy 域 handler 工厂
 *
 * 探测前把「DB 当前值」重新注入 proxiedFetch——handler 不依赖 applyProxyChange
 * 是否已在别处跑过（幂等，读库即真源）。
 */
export function createProxyHandlers(): InferHandlers<
  typeof IPC_DEFINITIONS,
  IpcHandlerContext
>['proxy'] {
  return {
    test: async (input) => {
      const cfg = parseProxyConfig(readSetting('proxy'));
      setProxyFetchConfig(cfg);
      if (cfg.mode !== 'fixed' || cfg.url === undefined) {
        return {
          ok: false,
          kind: 'not-applicable',
          message: '当前非自定义代理模式（system/direct 无需测试）',
        };
      }
      const target = input?.targetUrl ?? DEFAULT_PROBE_TARGET;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('timeout'), PROBE_TIMEOUT_MS);
      try {
        // 网络层可达即算通（任何 HTTP 状态都意味着代理与目标链路成立）
        await proxiedFetch(target, {
          signal: controller.signal,
        });
        return { ok: true, kind: 'ok' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, kind: 'target-unreachable', message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
