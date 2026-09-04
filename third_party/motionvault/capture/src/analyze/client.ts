/**
 * 多 provider LLM HTTP 客户端（纯 fetch，无第三方依赖，可在扩展/书签浏览器环境直连）。
 * 支持 openai / anthropic / openai-compatible（DeepSeek、通义、本地 vLLM 等）。
 */
import type { AnalyzerOptions } from '../core/types';

export class AnalyzerHttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(status: number, bodySnippet: string, message?: string) {
    super(message ?? buildHttpMessage(status, bodySnippet));
    this.name = 'AnalyzerHttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export class ParseError extends Error {
  readonly rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'ParseError';
    this.rawText = rawText;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_MODELS: Record<AnalyzerOptions['provider'], string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5-20250929',
  'openai-compatible': 'deepseek-chat',
};

function buildHttpMessage(status: number, bodySnippet: string): string {
  let hint = '';
  if (status === 401 || status === 403) hint = '（认证失败：请检查 API key 是否正确、是否有该模型权限）';
  else if (status === 429) hint = '（请求被限流：请稍后重试或检查账户额度/速率限制）';
  return `LLM 请求失败 HTTP ${status}${hint}：${bodySnippet}`;
}

export interface ChatParams {
  system: string;
  user: string;
  opts: AnalyzerOptions;
  /** vision 模式抽帧（dataURL jpeg）；仅 anthropic/openai 支持图片输入 */
  frames?: string[];
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 从响应 JSON 中取出 assistant 文本 */
  extract: (json: unknown) => string | null;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function openaiUserContent(user: string, frames?: string[]): string | OpenAIContentPart[] {
  if (!frames || frames.length === 0) return user;
  return [
    { type: 'text', text: user },
    ...frames.map((f): OpenAIContentPart => ({ type: 'image_url', image_url: { url: f } })),
  ];
}

function anthropicUserContent(user: string, frames?: string[]): string | AnthropicContentPart[] {
  if (!frames || frames.length === 0) return user;
  const parts: AnthropicContentPart[] = frames.map((f) => {
    // dataURL: "data:image/jpeg;base64,xxxx"
    const m = /^data:([^;]+);base64,(.+)$/.exec(f);
    return m
      ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
      : { type: 'text', text: `[frame: ${f.slice(0, 64)}]` };
  });
  parts.push({ type: 'text', text: user });
  return parts;
}

function getPath(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function buildRequest(params: ChatParams): ProviderRequest {
  const { system, user, opts, frames } = params;
  const model = opts.model ?? DEFAULT_MODELS[opts.provider];

  if (opts.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: openaiUserContent(user, frames) },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
      extract: (json) => {
        const v = getPath(json, ['choices', 0, 'message', 'content']);
        return typeof v === 'string' ? v : null;
      },
    };
  }

  if (opts.provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        // 扩展/书签场景是浏览器直连 Anthropic API
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model,
        max_tokens: 4096,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: anthropicUserContent(user, frames) }],
      },
      extract: (json) => {
        const v = getPath(json, ['content', 0, 'text']);
        return typeof v === 'string' ? v : null;
      },
    };
  }

  // openai-compatible：DeepSeek / 通义 / 本地 vLLM 等
  const base = opts.baseUrl?.replace(/\/+$/, '');
  if (!base) {
    throw new Error('provider=openai-compatible 时必须在 AnalyzerOptions.baseUrl 中提供 API 地址');
  }
  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: openaiUserContent(user, frames) },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    },
    extract: (json) => {
      const v = getPath(json, ['choices', 0, 'message', 'content']);
      return typeof v === 'string' ? v : null;
    },
  };
}

/** 从模型输出中提取 JSON 对象文本：剥离 ```json 围栏、截取首个 { 到末个 } */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  // 剥离 markdown 围栏
  const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ParseError('模型输出中找不到 JSON 对象', text);
  }
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new ParseError(`JSON 解析失败: ${(err as Error).message}`, text);
  }
}

async function postJson(req: ProviderRequest, signal: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`LLM 请求超时（>${DEFAULT_TIMEOUT_MS / 1000}s）或被取消`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AnalyzerHttpError(res.status, text.slice(0, 200));
  }

  const json: unknown = await res.json();
  const content = req.extract(json);
  if (content === null || content.trim() === '') {
    throw new ParseError('LLM 响应结构异常：未找到 assistant 文本', JSON.stringify(json).slice(0, 500));
  }
  return content;
}

function combineSignal(userSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onUserAbort = () => controller.abort(userSignal!.reason);
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
    },
  };
}

const RETRY_HINT = '\n\n上次输出不是合法 JSON，请只输出一个 JSON 对象，不要任何额外文字或 markdown 围栏。';

/**
 * 统一 chat 接口：发一次请求，解析失败（非合法 JSON）时自动重试一次。
 * 返回解析后的 JSON 对象；重试仍失败抛 ParseError。
 */
export async function chat(params: ChatParams): Promise<{ json: unknown; rawText: string }> {
  const { opts } = params;
  const { signal, cancel } = combineSignal(opts.signal, DEFAULT_TIMEOUT_MS);
  try {
    let user = params.user;
    for (let attempt = 0; attempt < 2; attempt++) {
      const req = buildRequest({ ...params, user });
      const rawText = await postJson(req, signal);
      try {
        return { json: extractJsonObject(rawText), rawText };
      } catch (err) {
        if (!(err instanceof ParseError) || attempt === 1) throw err;
        user = params.user + RETRY_HINT;
      }
    }
    // 不可达
    throw new ParseError('unexpected', '');
  } finally {
    cancel();
  }
}
