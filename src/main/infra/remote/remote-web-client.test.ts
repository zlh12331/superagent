import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REMOTE_CLIENT_CSP, REMOTE_CLIENT_HTML } from './remote-web-client';

function inlineBlock(tag: 'script' | 'style'): string {
  const matched = new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(REMOTE_CLIENT_HTML);
  const body = matched?.[1];
  if (body === undefined) {
    throw new Error(`控制页缺少内联 <${tag}>`);
  }
  return body;
}

function cspSource(directive: 'script-src' | 'style-src'): string {
  const matched = new RegExp(`${directive} '([^']+)'`).exec(REMOTE_CLIENT_CSP);
  const value = matched?.[1];
  if (value === undefined) {
    throw new Error(`CSP 缺少 ${directive}`);
  }
  return value;
}

function sha256(source: string): string {
  return `sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}`;
}

describe('远程控制手机页（CSP 与内容完整性）', () => {
  it('CSP 哈希与内联脚本/样式字节一致（页面或哈希单边改动即失效）', () => {
    expect(cspSource('script-src')).toBe(sha256(inlineBlock('script')));
    expect(cspSource('style-src')).toBe(sha256(inlineBlock('style')));
  });

  it('零外部资源：无远程脚本/样式/图片引用，无 unsafe-inline', () => {
    expect(REMOTE_CLIENT_HTML).not.toMatch(/src\s*=\s*["'](https?:)?\/\//);
    expect(REMOTE_CLIENT_HTML).not.toMatch(/href\s*=\s*["'](https?:)?\/\//);
    expect(REMOTE_CLIENT_CSP).not.toContain('unsafe-inline');
    expect(REMOTE_CLIENT_CSP).toContain("default-src 'none'");
  });

  it('模型输出仅经 textContent 注入（不拼 innerHTML，杜绝渲染层 XSS）', () => {
    expect(REMOTE_CLIENT_HTML).not.toContain('innerHTML');
    expect(REMOTE_CLIENT_HTML).toContain('textContent');
  });

  it('令牌只从 URL fragment 读入并即时抹除，页面常量不含任何令牌', () => {
    expect(REMOTE_CLIENT_HTML).toContain('location.hash');
    expect(REMOTE_CLIENT_HTML).toContain('history.replaceState');
    expect(REMOTE_CLIENT_HTML).toContain('sessionStorage');
    expect(REMOTE_CLIENT_HTML).not.toContain('localStorage');
  });
});
