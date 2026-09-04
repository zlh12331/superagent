/**
 * MotionLens LLM 分析器测试（node --test，环境 Node 20 不支持 --experimental-strip-types，
 * 因此用 .mjs + esbuild 现场打包 src/analyze 为 ESM 再动态 import；fetch 全部 mock）。
 *
 * 运行：cd capture && node --test test/
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.build');
const OUT_FILE = path.join(OUT_DIR, 'analyze.bundle.mjs');

let analyzeCapture, validateEffectDraft, extractJsonObject, buildPrompts, truncateReportJson, ParseError, AnalyzerHttpError;

before(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/analyze/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: OUT_FILE,
    logLevel: 'silent',
  });
  const mod = await import(OUT_FILE);
  ({ analyzeCapture, validateEffectDraft, extractJsonObject, buildPrompts, truncateReportJson, ParseError, AnalyzerHttpError } = mod);
});

// ---------- 测试工具 ----------

function fakeReport(overrides = {}) {
  return {
    tool: { name: 'motionlens', version: '0.1.0' },
    url: 'https://example.com/hero',
    pageTitle: 'Hero',
    capturedAt: '2025-01-01T00:00:00.000Z',
    viewport: { w: 1280, h: 800 },
    elementBox: { x: 0, y: 0, width: 200, height: 100 },
    computedBase: { color: 'rgb(20,20,20)', backgroundColor: 'rgb(255,255,255)' },
    animations: [
      {
        id: 'a1',
        source: 'css',
        name: 'fade-up',
        keyframes: [
          { offset: 0, props: { opacity: '0', transform: 'translateY(12px)' } },
          { offset: 1, props: { opacity: '1', transform: 'translateY(0px)' } },
        ],
        timing: { duration: 400, delay: 0, iterations: 1, easing: 'ease-out' },
        targetPath: 'body > div.hero',
        target: { tag: 'div', classes: ['hero'], childCount: 2 },
        trigger: 'load',
      },
    ],
    domSnippet: '<div class="hero"><h1>Hi</h1></div>',
    ...overrides,
  };
}

function fakeDraft(overrides = {}) {
  return {
    title: '淡入上移',
    titleEn: 'fade-up',
    category: 'layout',
    description: '加载时元素淡入并上移',
    techTags: ['css-keyframes', 'loop'],
    principle: '400ms ease-out，opacity 0→1，translateY 12px→0。',
    prompt: '用 React 19 + TypeScript 实现……',
    promptEn: 'Build a React 19 + TypeScript component...',
    difficulty: 'easy',
    confidence: 0.9,
    sourceUrl: 'https://evil.example/should-be-overwritten',
    ...overrides,
  };
}

/** 构造 OpenAI 风格的 fetch 响应 */
function openaiResponse(content, { status = 200, rawBody = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => rawBody || JSON.stringify({ error: 'boom' }),
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function anthropicResponse(content) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ content: [{ type: 'text', text: content }] }),
  };
}

/** 安装 fetch mock，返回捕获到的调用记录 [{url, init}] */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(calls.length);
  };
  return calls;
}

// ---------- provider 请求构造 ----------

test('openai provider：url/headers/body 关键字段', async () => {
  const calls = mockFetch(() => openaiResponse(JSON.stringify(fakeDraft())));
  await analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'sk-test-openai' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['authorization'], 'Bearer sk-test-openai');
  assert.equal(c.init.headers['content-type'], 'application/json');
  assert.equal(c.body.model, 'gpt-4o');
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.equal(c.body.messages[0].role, 'system');
  assert.equal(c.body.messages[1].role, 'user');
  assert.ok(c.body.messages[0].content.includes('资深前端动效工程师'));
});

test('anthropic provider：url/headers/system 独立字段/默认模型', async () => {
  const calls = mockFetch(() => anthropicResponse(JSON.stringify(fakeDraft())));
  await analyzeCapture(fakeReport(), { provider: 'anthropic', apiKey: 'sk-ant-test' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(c.body.model, 'claude-sonnet-4-5-20250929');
  assert.ok(typeof c.body.system === 'string' && c.body.system.length > 0);
  // anthropic 的 messages 里不重复 system
  assert.ok(c.body.messages.every((m) => m.role !== 'system'));
  assert.equal(c.body.messages[0].role, 'user');
});

test('openai-compatible provider：baseUrl 拼接 + 自定义模型', async () => {
  const calls = mockFetch(() => openaiResponse(JSON.stringify(fakeDraft())));
  await analyzeCapture(fakeReport(), {
    provider: 'openai-compatible',
    apiKey: 'ds-key',
    baseUrl: 'https://api.deepseek.com/v1/',
    model: 'deepseek-chat',
  });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].init.headers['authorization'], 'Bearer ds-key');
  assert.equal(calls[0].body.model, 'deepseek-chat');
});

test('openai-compatible 缺 baseUrl 直接抛错，不发请求', async () => {
  const calls = mockFetch(() => openaiResponse('{}'));
  await assert.rejects(
    analyzeCapture(fakeReport(), { provider: 'openai-compatible', apiKey: 'x' }),
    /baseUrl/
  );
  assert.equal(calls.length, 0);
});

// ---------- 响应解析与重试 ----------

test('```json 围栏输出可正确解析', async () => {
  const fenced = '好的，这是结果：\n```json\n' + JSON.stringify(fakeDraft(), null, 2) + '\n```\n希望有帮助';
  const calls = mockFetch(() => openaiResponse(fenced));
  const draft = await analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'k' });
  assert.equal(draft.title, '淡入上移');
  assert.equal(calls.length, 1); // 无需重试
});

test('extractJsonObject：无 JSON 时抛 ParseError', () => {
  assert.throws(() => extractJsonObject('这不是 JSON'), (e) => e instanceof ParseError);
  assert.throws(() => extractJsonObject('{broken json}'), (e) => e instanceof ParseError);
});

test('首次输出非法 JSON 自动重试一次（user 追加提示），第二次成功', async () => {
  const calls = mockFetch((n) =>
    openaiResponse(n === 1 ? '随便聊两句，不给 JSON' : JSON.stringify(fakeDraft()))
  );
  const draft = await analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'k' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.messages[1].content.includes('上次输出不是合法 JSON'));
  assert.equal(draft.titleEn, 'fade-up');
});

test('重试后仍非法 → 抛 ParseError', async () => {
  const calls = mockFetch(() => openaiResponse('依然不是 JSON'));
  await assert.rejects(
    analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'k' }),
    (e) => e instanceof ParseError
  );
  assert.equal(calls.length, 2);
});

// ---------- HTTP 错误信息 ----------

test('429 → 错误信息含状态码与限流提示', async () => {
  mockFetch(() => ({
    ok: false,
    status: 429,
    text: async () => '{"error":{"message":"rate limit reached for gpt-4o"}}',
    json: async () => ({}),
  }));
  await assert.rejects(
    analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'k' }),
    (e) => {
      assert.ok(e instanceof AnalyzerHttpError);
      assert.equal(e.status, 429);
      assert.match(e.message, /429/);
      assert.match(e.message, /限流/);
      assert.match(e.message, /rate limit/); // 响应前 200 字符被带入
      return true;
    }
  );
});

test('401 → 错误信息提示检查 API key', async () => {
  mockFetch(() => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"invalid api key"}}',
    json: async () => ({}),
  }));
  await assert.rejects(
    analyzeCapture(fakeReport(), { provider: 'openai', apiKey: 'bad' }),
    (e) => {
      assert.match(e.message, /401/);
      assert.match(e.message, /API key/);
      return true;
    }
  );
});

// ---------- 空检查与 vision 模式 ----------

test('animations 与 frames 皆空 → 直接抛错，不调 LLM', async () => {
  const calls = mockFetch(() => openaiResponse(JSON.stringify(fakeDraft())));
  await assert.rejects(
    analyzeCapture(fakeReport({ animations: [] }), { provider: 'openai', apiKey: 'k' }),
    /无法分析/
  );
  assert.equal(calls.length, 0);
});

test('vision 模式：animations 空 + frames 存在 → prompt 改为帧描述任务', async () => {
  const frames = ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'];
  const calls = mockFetch(() => openaiResponse(JSON.stringify(fakeDraft())));
  const draft = await analyzeCapture(fakeReport({ animations: [], frames }), {
    provider: 'openai',
    apiKey: 'k',
  });
  assert.equal(calls.length, 1);
  const userContent = calls[0].body.messages[1].content;
  assert.ok(Array.isArray(userContent)); // openai 图片走 content parts
  assert.equal(userContent[0].type, 'text');
  assert.match(userContent[0].text, /VISION/);
  assert.equal(userContent.filter((p) => p.type === 'image_url').length, 2);
  assert.equal(draft.sourceUrl, 'https://example.com/hero');
});

// ---------- validateEffectDraft ----------

test('非法 category 按 techTags 启发式修正', () => {
  const draft = validateEffectDraft(
    fakeDraft({ category: 'hover-card', techTags: ['gsap', 'scrolltrigger'] }),
    fakeReport()
  );
  assert.equal(draft.category, 'scroll');
  const springDraft = validateEffectDraft(
    fakeDraft({ category: '???', techTags: ['spring', 'waapi'] }),
    fakeReport()
  );
  assert.equal(springDraft.category, 'spring');
  const fallback = validateEffectDraft(fakeDraft({ category: 'nope', techTags: ['canvas'] }), fakeReport());
  assert.equal(fallback.category, 'lab');
});

test('confidence 截断到 [0,1]，非法值给默认 0.5', () => {
  assert.equal(validateEffectDraft(fakeDraft({ confidence: 1.7 }), fakeReport()).confidence, 1);
  assert.equal(validateEffectDraft(fakeDraft({ confidence: -3 }), fakeReport()).confidence, 0);
  assert.equal(validateEffectDraft(fakeDraft({ confidence: 'high' }), fakeReport()).confidence, 0.5);
});

test('techTags 去重限 8 个；sourceUrl 从 report 回填；difficulty 非法归一为 medium', () => {
  const draft = validateEffectDraft(
    fakeDraft({
      techTags: ['GSAP', 'gsap', 'scroll', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
      difficulty: 'extreme',
    }),
    fakeReport()
  );
  assert.equal(draft.techTags.length, 8);
  assert.equal(new Set(draft.techTags).size, draft.techTags.length);
  assert.equal(draft.techTags[0], 'gsap');
  assert.equal(draft.sourceUrl, 'https://example.com/hero');
  assert.equal(draft.difficulty, 'medium');
});

test('prompt/promptEn/title 为空 → 抛 SchemaError', () => {
  assert.throws(
    () => validateEffectDraft(fakeDraft({ prompt: '   ' }), fakeReport()),
    /prompt/
  );
  assert.throws(
    () => validateEffectDraft({ not: 'an object of draft' }, fakeReport()),
    /缺少必填字段/
  );
  assert.throws(() => validateEffectDraft(null, fakeReport()), /不是 JSON 对象/);
});

test('titleEn 归一为 kebab-case', () => {
  const draft = validateEffectDraft(fakeDraft({ titleEn: 'Magnetic Button!' }), fakeReport());
  assert.equal(draft.titleEn, 'magnetic-button');
});

// ---------- prompts 构建 ----------

test('user prompt 注入 report JSON 且含 few-shot 示例与技术栈约束', () => {
  const { system, user, vision } = buildPrompts(fakeReport());
  assert.equal(vision, false);
  assert.match(system, /资深前端动效工程师/);
  assert.match(system, /CategoryId|12 个分类/);
  assert.match(user, /fade-up/); // report 中的 animation name 被注入
  assert.match(user, /React 19 \+ TypeScript/);
  assert.match(user, /禁止引入 UI 组件库/);
  assert.match(user, /悬浮卡片/); // few-shot 示例
  assert.match(user, /hover-lift-card/);
});

test('report JSON 超 12KB 时按 animations>computedBase>domSnippet 顺序截断', () => {
  const big = fakeReport({
    domSnippet: 'x'.repeat(20000),
    computedBase: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(50)])),
  });
  const out = truncateReportJson(big);
  assert.ok(out.length <= 12 * 1024 + 64, `截断后长度 ${out.length} 应 ≤ 12KB`);
});
