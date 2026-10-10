import { session } from 'electron';
import { logger } from '../../utils/logger';
import { resetAIProvider } from '../ai/llm-client/ai-provider';
import { setProxyFetchConfig } from './proxied-fetch';
import {
  buildChromiumProxyConfig,
  buildProxyUrl,
  maskProxyUrl,
  parseProxyConfig,
} from './proxy-resolver';

/** electron-updater 专用分区（ElectronHttpExecutor.NET_SESSION_NAME 实测同名） */
const UPDATER_PARTITION = 'electron-updater';
/** 浏览器预览内存分区（preview-service.ts PREVIEW_PARTITION 同值） */
const PREVIEW_PARTITION = 'browser-preview';

/**
 * 应用代理配置变更（四路径统一出口）
 *
 * @param raw settings.proxy 的原始值（undefined = 键已删/resetAll → 回 system）
 */
export async function applyProxyChange(raw: unknown): Promise<void> {
  const cfg = parseProxyConfig(raw);
  setProxyFetchConfig(cfg);
  await applyChromiumSessions(cfg);
  applyEnvSideChannel(cfg);
  resetAIProvider();
  logger.info(
    { mode: cfg.mode, ...(cfg.url !== undefined ? { url: maskProxyUrl(cfg.url) } : {}) },
    '代理配置已应用',
  );
}

/** Chromium 三分区 setProxy（反例 7：固定顺序 default → updater → preview） */
async function applyChromiumSessions(cfg: ReturnType<typeof parseProxyConfig>): Promise<void> {
  const proxyConfig = buildChromiumProxyConfig(cfg);
  const targets: readonly [string, ReturnType<typeof session.fromPartition>][] = [
    ['default', session.defaultSession],
    ['electron-updater', session.fromPartition(UPDATER_PARTITION, { cache: false })],
    ['browser-preview', session.fromPartition(PREVIEW_PARTITION)],
  ];
  for (const [name, ses] of targets) {
    try {
      await ses.setProxy(proxyConfig);
    } catch (err) {
      logger.warn({ session: name, error: String(err) }, '分区代理设置失败（继续其余分区）');
    }
  }
}

/**
 * env 侧门（axios 栈：飞书 SDK 原生读 http_proxy/https_proxy）
 *
 * 全局副作用收敛于此单处：仅 fixed 写（大小写双写，axios 两读都有），
 * 其它模式清空全部六键（含小写，防残留）。NO_PROXY 固定 localhost 家族
 * （与 shouldBypass 硬规则同语义，axios 栈的本地调用兜底）。
 */
function applyEnvSideChannel(cfg: ReturnType<typeof parseProxyConfig>): void {
  const keys = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
  ] as const;
  const proxyUrl = buildProxyUrl(cfg);
  if (proxyUrl === undefined) {
    for (const key of keys) {
      delete process.env[key];
    }
    return;
  }
  process.env['HTTPS_PROXY'] = proxyUrl;
  process.env['https_proxy'] = proxyUrl;
  process.env['HTTP_PROXY'] = proxyUrl;
  process.env['http_proxy'] = proxyUrl;
  process.env['NO_PROXY'] = 'localhost,127.0.0.1,::1';
  process.env['no_proxy'] = 'localhost,127.0.0.1,::1';
}
