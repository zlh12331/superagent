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

const UPDATER_PARTITION = 'electron-updater';
const PREVIEW_PARTITION = 'browser-preview';

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
