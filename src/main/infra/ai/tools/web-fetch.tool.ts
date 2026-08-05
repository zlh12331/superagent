// src/main/infra/ai/tools/web-fetch.tool.ts
// web_fetch 工具：抓取网页正文（对齐 qwen web_fetch 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 全局 fetch（Node 18+）抓取 URL → HTML 去标签 → 正文截断
// - 仅支持 http/https；超时 15s；隐私考虑 permission='ask'
// - 失败（网络/超时/非 2xx）返回明确错误，不抛异常
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** 抓取超时（毫秒） */
const FETCH_TIMEOUT_MS = 15_000;
/** 正文最大字符数（防单次响应膨胀） */
const MAX_CONTENT_CHARS = 4_000;

/** web_fetch 入参 */
const WebFetchInputSchema = z.object({
  /** 目标 URL（仅 http/https） */
  url: z.string().url().max(500),
  /** 正文截断上限（缺省 4000） */
  maxChars: z.number().int().min(100).max(20_000).optional(),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

/**
 * 创建 web_fetch 工具（无依赖注入：使用全局 fetch）
 */
export function createWebFetchTool(): Tool<WebFetchInput> {
  return {
    name: 'web_fetch',
    description:
      '抓取网页内容并返回正文文本（去 HTML 标签）。适合查阅文档、搜索资料、核实信息。仅支持 http/https 地址。',
    inputSchema: WebFetchInputSchema,
    permission: 'ask',
    category: 'read',
    execute: async (input: WebFetchInput, _ctx: ToolContext): Promise<ToolResult> => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        return { title: 'web_fetch 失败', output: `无效的 URL：${input.url}` };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return {
          title: 'web_fetch 失败',
          output: `不支持的协议：${url.protocol}（仅 http/https）`,
        };
      }

      try {
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
        if (!response.ok) {
          return {
            title: 'web_fetch 失败',
            output: `HTTP ${response.status} ${response.statusText}：${url.hostname}`,
          };
        }
        const html = await response.text();
        const text = stripHtml(html).trim();
        if (text.length === 0) {
          return {
            title: 'web_fetch 完成',
            output: '（页面无可提取的正文文本，可能为动态渲染页面）',
          };
        }
        const max = input.maxChars ?? MAX_CONTENT_CHARS;
        const content = text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
        return {
          title: `web_fetch: ${url.hostname}`,
          output: `来源：${url.toString()}\n\n${content}`,
        };
      } catch (err: unknown) {
        return {
          title: 'web_fetch 失败',
          output: `抓取失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/** 带超时的 fetch（AbortController 取消） */
async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → 正文文本：去 script/style/标签/实体（弱耦合纯函数，借鉴自 qwen web 工具收敛） */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
}
