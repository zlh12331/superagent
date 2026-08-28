// src/main/infra/remote/remote-web-client.ts
// 远程控制内置手机 Web 客户端（GET / 直开即用）
// ──────────────────────────────────────────────────────────────
// 为什么要有这个页面：远程控制的价值是"手边没有客户端也能立刻用"。
// 配对地址/二维码扫开如果是 404，扫码就只是把令牌搬运了一遍——
// 本模块补上承接端：浏览器打开 → 输令牌（或从 URL fragment 自动读取）
// → 直接和桌面端 Agent 对话，走阶段 3 的 SSE 增量回传。
//
// 令牌传递（关键安全约定）：
// - 二维码/链接形如 http://192.168.1.10:4173#<token>
// - URL fragment 不会随 HTTP 请求发往服务端，也不进服务端日志与 Referer，
//   页面读入后立即 history.replaceState 抹掉，并只存 sessionStorage（关页即散）
// - 页面自身是纯静态常量：不含任何令牌，任何人拿到页面源码也连不上
//
// CSP：脚本与样式都是本模块的固定常量，因此用 sha256 哈希授权
// （default-src 'none' 起白名单，无 unsafe-inline、无外部源）。
// 页面内所有模型输出与用户输入一律走 textContent 注入，不拼 innerHTML。
//
// 已知边界（有意不做）：
// - 不做多会话列表/历史回看：桌面端才是会话主端，本页定位是"远程指挥"
// - 不做断线续传：回合继续执行并落库，重开页面从新命令继续（阶段 4 议题）
// ──────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';

/** 页面样式（内联 <style>，CSP 按内容哈希授权） */
const REMOTE_CLIENT_STYLE = `
:root {
  color-scheme: dark;
  --bg: #101014;
  --panel: #1a1a20;
  --line: #2a2a33;
  --fg: #ececf1;
  --muted: #9a9aa6;
  --accent: #4d9dff;
  --user: #2a3550;
  --warn: #e0a63c;
  --err: #ef6a6a;
  --ok: #4ecb8f;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  display: flex; flex-direction: column; height: 100dvh;
}
header {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: calc(env(safe-area-inset-top) + 10px) 14px 10px;
  border-bottom: 1px solid var(--line); background: var(--panel);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
.dot.ok { background: var(--ok); }
.dot.err { background: var(--err); }
.name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; }
main {
  flex: 1 1 auto; overflow-y: auto; padding: 14px; display: flex;
  flex-direction: column; gap: 10px; -webkit-overflow-scrolling: touch;
}
.msg { max-width: 88%; padding: 9px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: var(--user); border-bottom-right-radius: 4px; }
.msg.assistant { align-self: flex-start; background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
.msg.system { align-self: center; background: none; color: var(--muted); font-size: 12px; padding: 2px 6px; }
.msg.err { color: var(--err); }
.chip {
  align-self: flex-start; font-size: 12px; color: var(--muted);
  border: 1px dashed var(--line); border-radius: 999px; padding: 2px 9px;
}
.cursor::after { content: ""; display: inline-block; width: 6px; height: 14px; background: var(--accent); vertical-align: -2px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
.pair {
  flex: 0 0 auto; margin: 14px; padding: 16px; border: 1px solid var(--line);
  border-radius: 14px; background: var(--panel); display: flex; flex-direction: column; gap: 10px;
}
.pair h2 { margin: 0; font-size: 15px; }
.pair p { margin: 0; font-size: 12.5px; color: var(--muted); }
footer {
  flex: 0 0 auto; display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 14px calc(env(safe-area-inset-bottom) + 12px);
  border-top: 1px solid var(--line); background: var(--panel);
}
textarea, input {
  flex: 1 1 auto; min-width: 0; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px;
  font: inherit; resize: none; outline: none;
}
textarea:focus, input:focus { border-color: var(--accent); }
button {
  flex: 0 0 auto; background: var(--accent); color: #0b0b0f; border: none;
  border-radius: 10px; padding: 9px 16px; font: inherit; font-weight: 600;
}
button:disabled { opacity: .45; }
button.ghost { background: none; color: var(--muted); border: 1px solid var(--line); font-weight: 400; padding: 4px 10px; font-size: 12px; margin-left: auto; }
.hide { display: none !important; }
`.trim();

/**
 * 页面脚本（内联 <script>，CSP 按内容哈希授权）
 *
 * 刻意不使用模板字符串：本常量要原样嵌入外层 TS 模板字面量，
 * 反引号与 ${} 都需要转义，直写字符串拼接可避免这类隐性错位。
 */
const REMOTE_CLIENT_SCRIPT = `
'use strict';
var I18N = {
  zh: {
    pairing: '配对桌面端',
    pairHint: '输入桌面端「设置 → 移动端」中显示的会话令牌。',
    tokenPlaceholder: '会话令牌',
    connect: '连接',
    disconnect: '退出配对',
    placeholder: '发给桌面端 Agent 的命令…',
    send: '发送',
    connecting: '连接中',
    offline: '桌面端不可达',
    rejected: '令牌不正确，请在桌面端确认后重试。',
    notPaired: '请先完成配对。',
    empty: '（本轮无文本输出）',
    disconnected: '连接已断开：任务仍在桌面端继续，完成后可在桌面端会话中查看。',
    aborted: '已中断',
    maxSteps: '达步数上限',
    errored: '异常结束',
    timeout: '执行超时'
  },
  en: {
    pairing: 'Pair with desktop',
    pairHint: 'Enter the session token shown in Settings → Mobile.',
    tokenPlaceholder: 'Session token',
    connect: 'Connect',
    disconnect: 'Unpair',
    placeholder: 'Command for the desktop agent…',
    send: 'Send',
    connecting: 'Connecting',
    offline: 'Desktop unreachable',
    rejected: 'Wrong token. Confirm it on the desktop and retry.',
    notPaired: 'Pair with the desktop first.',
    empty: '(no text output)',
    disconnected: 'Connection lost: the turn keeps running on the desktop.',
    aborted: 'aborted',
    maxSteps: 'max steps reached',
    errored: 'ended with error',
    timeout: 'timed out'
  }
};
var LANG = (navigator.language || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
function L(key) { var table = I18N[LANG]; return table[key] || I18N.en[key] || key; }
function el(id) { return document.getElementById(id); }

var TOKEN_KEY = 'car.token';
var CLIENT_KEY = 'car.clientId';
// 同一 clientId 复用桌面端同一会话（多轮上下文键）：页面会话内稳定，关页重开则新会话
function clientId() {
  var id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = 'web-' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}
// fragment 优先（扫码/点链接带来的令牌）：读后立刻改写 URL，避免停留在地址栏与历史
function adoptTokenFromHash() {
  var hash = location.hash.replace(/^#/, '');
  if (hash) {
    sessionStorage.setItem(TOKEN_KEY, hash);
    history.replaceState(null, '', location.pathname);
  }
}
adoptTokenFromHash();
var token = sessionStorage.getItem(TOKEN_KEY) || '';
var busy = false;

function text(kind, value) {
  var node = document.createElement('div');
  node.className = 'msg ' + kind;
  node.textContent = value;
  el('log').appendChild(node);
  scrollBottom();
  return node;
}
function chip(value) {
  var node = document.createElement('div');
  node.className = 'chip';
  node.textContent = value;
  el('log').appendChild(node);
  scrollBottom();
}
function scrollBottom() {
  var log = el('log');
  log.scrollTop = log.scrollHeight;
}
function setPaired(paired) {
  el('pair').classList.toggle('hide', paired);
  el('composer').classList.toggle('hide', !paired);
  el('forget').classList.toggle('hide', !paired);
  el('input').disabled = !paired;
  el('send').disabled = !paired;
}
function setDot(cls, label) {
  el('dot').className = 'dot ' + cls;
  el('badge').textContent = label;
}
function reasonLabel(reason) {
  if (reason === 'aborted') return L('aborted');
  if (reason === 'max-steps') return L('maxSteps');
  if (reason === 'error') return L('errored');
  if (reason === 'timeout') return L('timeout');
  return '';
}

/** 解析 SSE 文本块：返回未消费的尾部（帧可能跨 chunk 被切断） */
function drainFrames(buffer, onFrame) {
  var boundary = buffer.indexOf('\\n\\n');
  while (boundary >= 0) {
    var frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    var name = 'message';
    var dataLines = [];
    var lines = frame.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.charAt(0) === ':') continue;
      if (line.indexOf('event:') === 0) name = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      try { onFrame(name, JSON.parse(dataLines.join('\\n'))); } catch (e) {}
    }
    boundary = buffer.indexOf('\\n\\n');
  }
  return buffer;
}

function send() {
  var input = el('input');
  var body = input.value.trim();
  if (busy || !token) { if (!token) text('system', L('notPaired')); return; }
  if (!body) return;
  input.value = '';
  autosize();
  busy = true;
  el('send').disabled = true;
  text('user', body);
  var bubble = text('assistant', '');
  bubble.classList.add('cursor');
  var streamed = 0;
  // 老浏览器（iOS < 14.1）无 fetch 响应流：不声明 SSE 能力，服务端回退同步 JSON
  var canStream = typeof window.ReadableStream === 'function';
  var onFrame = function (name, data) {
    if (name === 'delta') {
      bubble.textContent += data.text;
      streamed += String(data.text).length;
      scrollBottom();
    } else if (name === 'tool') {
      chip('🔧 ' + data.toolName);
    } else if (name === 'error') {
      bubble.classList.add('err');
      bubble.textContent += '\\n❌ ' + data.message;
    } else if (name === 'end') {
      bubble.classList.remove('cursor');
      if (!data.accepted) { bubble.classList.add('err'); }
      // 增量已渲染正文时 end.reply 不再重播（避免同一文本出现两遍）
      if (streamed === 0) { bubble.textContent = data.reply || L('empty'); }
      var label = reasonLabel(data.reason || '');
      if (label) chip('⚠ ' + label);
    }
  };
  fetch('/command', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: canStream ? 'text/event-stream' : 'application/json'
    },
    body: JSON.stringify({ sessionToken: token, text: body, clientId: clientId() })
  })
    .then(function (res) {
      if (res.status === 403) {
        sessionStorage.removeItem(TOKEN_KEY);
        token = '';
        setPaired(false);
        text('system', L('rejected'));
        return null;
      }
      if (!res.ok) {
        text('system', 'HTTP ' + res.status);
        return null;
      }
      if (!canStream || !res.body) {
        return res.json().then(function (result) { onFrame('end', result); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      var pump = function () {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            buffer = drainFrames(buffer + '\\n\\n', onFrame);
            bubble.classList.remove('cursor');
            if (streamed === 0 && !bubble.textContent) bubble.textContent = L('disconnected');
            return;
          }
          buffer = drainFrames(buffer + decoder.decode(chunk.value, { stream: true }), onFrame);
          return pump();
        });
      };
      return pump();
    })
    .catch(function () {
      bubble.classList.remove('cursor');
      bubble.classList.add('err');
      if (!bubble.textContent) bubble.textContent = L('offline');
      setDot('err', L('offline'));
    })
    .then(function () {
      busy = false;
      el('send').disabled = false;
      el('input').focus();
    });
}

function autosize() {
  var input = el('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

el('connect').addEventListener('click', function () {
  var value = el('token').value.trim();
  if (!value) return;
  token = value;
  sessionStorage.setItem(TOKEN_KEY, token);
  el('token').value = '';
  setPaired(true);
  el('input').focus();
});
el('forget').addEventListener('click', function () {
  sessionStorage.removeItem(TOKEN_KEY);
  token = '';
  setPaired(false);
});
el('composer').addEventListener('submit', function (event) {
  event.preventDefault();
  send();
});
el('input').addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
el('input').addEventListener('input', autosize);

setPaired(!!token);
el('pairHint').textContent = L('pairHint');
el('token').placeholder = L('tokenPlaceholder');
el('connect').textContent = L('connect');
el('forget').textContent = L('disconnect');
el('input').placeholder = L('placeholder');
el('send').textContent = L('send');
el('pairTitle').textContent = L('pairing');
text('system', L('connecting'));
fetch('/info')
  .then(function (res) { return res.json(); })
  .then(function (info) {
    el('name').textContent = info.name || 'Code Agent';
    document.title = (info.name || 'Code Agent') + ' · Remote';
    setDot('ok', ':' + info.port);
  })
  .catch(function () { setDot('err', L('offline')); });
`.trim();

/** CSP 哈希授权：`sha256-<base64>` 覆盖内联 script / style 的精确字节 */
function cspHash(source: string): string {
  return `sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}`;
}

/**
 * 手机控制页 HTML（含内联样式与脚本，零外部资源）
 *
 * 拼接顺序即最终字节：CSP 头必须由同一批常量计算，故此处不做任何 trim/format 加工。
 */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#101014">
<title>Code Agent Remote</title>
<style>${REMOTE_CLIENT_STYLE}</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <span class="name" id="name">Code Agent</span>
  <span class="badge" id="badge"></span>
  <button type="button" class="ghost hide" id="forget"></button>
</header>
<main id="log"></main>
<div class="pair hide" id="pair">
  <h2 id="pairTitle"></h2>
  <p id="pairHint"></p>
  <input id="token" type="password" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  <button type="button" id="connect"></button>
</div>
<form id="composer" class="hide">
  <textarea id="input" rows="1" enterkeyhint="send"></textarea>
  <button type="submit" id="send"></button>
</form>
<script>${REMOTE_CLIENT_SCRIPT}</script>
</body>
</html>`;

/**
 * 控制页 CSP：白名单极窄——只允许同源 XHR/fetch 与本页哈希过的内联资源。
 *
 * 注意：`frame-ancestors` / `sandbox` 类指令在 <meta> 中无效，必须走响应头，
 * 因此本常量与 REMOTE_CLIENT_HTML 由同一处（remote-control 的 GET /）下发。
 */
export const REMOTE_CLIENT_CSP = [
  "default-src 'none'",
  `script-src '${cspHash(REMOTE_CLIENT_SCRIPT)}'`,
  `style-src '${cspHash(REMOTE_CLIENT_STYLE)}'`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
