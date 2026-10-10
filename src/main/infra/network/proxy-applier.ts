// proxy-applier.ts：代理变更的统一应用口（34 号 applyProxyChange 四路径收口于此）——
// Node fetch 配置 → Chromium 三分区 → env 侧通道 → AI provider 重置，一条链全改完
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

// updater 用独立分区（34 号实测：主分区代理不影响它），预览分区同理——三处都要各设一遍
const UPDATER_PARTITION = 'electron-updater';
const PREVIEW_PARTITION = 'browser-preview';

/**
 * 应用代理变更（启动序列与 settings:set:proxy 都走这里）
 *
 * 顺序敏感：先 setProxyFetchConfig 再重置 AI provider——provider 重建后新实例才会用到新代理
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

// env 侧通道：部分依赖库（未走 electron session 的）只认 HTTP(S)_PROXY 环境变量——
// 大小写各写一遍（不同库读法不同）；非 fixed 模式清空，避免残留旧代理
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
