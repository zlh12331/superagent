/**
 * settings.ts —— bookmarklet 的 BYOK 设置存储。
 * localStorage 可能被宿主页面 CSP / 沙箱 / 隐私模式禁用，所有读写均 try/catch，
 * 失败时静默降级为「仅提取数据」模式，绝不让设置读写本身抛出。
 */
import type { AnalyzerOptions } from '../../core/types';

export type Provider = AnalyzerOptions['provider'];

export interface BookmarkletSettings {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export const SETTINGS_KEY = 'motionlens:settings';

const PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'openai-compatible'];

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/** 读取设置；无设置 / 解析失败 / localStorage 不可用时返回 null。 */
export function loadSettings(): BookmarkletSettings | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!isProvider(obj.provider)) return null;
    const settings: BookmarkletSettings = {
      provider: obj.provider,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
    };
    if (typeof obj.model === 'string' && obj.model) settings.model = obj.model;
    if (typeof obj.baseUrl === 'string' && obj.baseUrl) settings.baseUrl = obj.baseUrl;
    return settings;
  } catch {
    return null;
  }
}

/** 保存设置；返回是否成功（localStorage 不可用时返回 false）。 */
export function saveSettings(settings: BookmarkletSettings): boolean {
  try {
    const clean: BookmarkletSettings = {
      provider: settings.provider,
      apiKey: settings.apiKey ?? '',
    };
    if (settings.model) clean.model = settings.model;
    if (settings.baseUrl) clean.baseUrl = settings.baseUrl;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** 清除已保存设置（同样不抛）。 */
export function clearSettings(): boolean {
  try {
    window.localStorage.removeItem(SETTINGS_KEY);
    return true;
  } catch {
    return false;
  }
}
