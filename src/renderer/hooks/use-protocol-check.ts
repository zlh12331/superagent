// src/renderer/hooks/use-protocol-check.ts
// IPC 协议版本校验（P0 契约加固）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 应用挂载时调 app:getStatus 获取主进程协议版本
// - 与渲染层内置 IPC_PROTOCOL_VERSION 比较，不匹配 → toast 提示重启
//   （主进程/渲染层来自不同构建时，避免暴露裸 zod 校验错误）
// - 浏览器模式（dev 预览）无 window.api：跳过
// ──────────────────────────────────────────────────────────────

import { IPC_PROTOCOL_VERSION } from '@code-agent/shared/renderer';
import * as Sentry from '@sentry/electron/renderer';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

/**
 * 启动时校验 IPC 协议版本（AppShell 挂载一次）
 *
 * 不匹配场景：自动更新后单侧先更新（主进程旧/新 vs 渲染层新/旧）。
 * 提示用户重启应用；不阻断正常功能（校验失败静默——非关键路径）。
 */
export function useProtocolCheck(): void {
  const { t } = useTranslation();

  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    let cancelled = false;
    window.api.app
      .getStatus()
      .then((res) => {
        if (cancelled) return;
        // error 响应由 unwrap 抛错 → 走下方 catch 静默（非关键路径）
        const data = unwrap(res);
        if (data.protocolVersion !== IPC_PROTOCOL_VERSION) {
          toast.warning(t('common.protocolMismatch'), {
            description: `${t('common.protocolMismatchDesc')} (main=${data.protocolVersion} / renderer=${IPC_PROTOCOL_VERSION})`,
            duration: 10_000,
          });
        }
      })
      .catch((error: unknown) => {
        // 不打扰用户（非关键路径），但上报 Sentry——协议版本读不到本身
        // 就是"主/渲染层不匹配"的强信号，静默会丢掉最有价值的现场。
        Sentry.captureException(error, { tags: { scope: 'use-protocol-check' } });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);
}
