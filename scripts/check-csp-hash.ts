// scripts/check-csp-hash.ts：首帧防闪脚本 ↔ CSP hash 一致性闸
// 判据：index.html head 的裸 <script> 内联块，其 sha256(base64) 必须出现在
// src/main/security/csp.ts 的 PRODUCTION_CSP script-src 中——改脚本后漏同步 hash 会被
// CSP 静默拦截，暗色用户首帧亮→暗闪且无任何报错，故以 build/CI 卡关防呆。
// 边界：纯静态文本断言，不启动浏览器、不校验 CSP 运行期行为。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THEME_FIRST_PAINT_KEY } from '../src/renderer/lib/theme-init';

/**
 * 剥离 HTML 注释（按 `<!--` / `-->` 分段取非注释部分）
 *
 * 不用正则 replace 删除：那属于「多字符序列净化」——删掉一段后两侧残余字符可能
 * 重新拼出 `<!--`，静态分析据此报不完整净化（CodeQL
 * js/incomplete-multi-character-sanitization，实测循环收敛的写法仍被报，属该规则的
 * 模式匹配局限）。改用 indexOf 游标单遍扫描，语义是「跳过注释区间」，不存在重组，
 * 且无正则回溯。
 *
 * 未闭合的 `<!--` 按 HTML 语义吞掉其后全部内容——此时首帧脚本提取会失败并卡关，
 * 正是期望行为（注释里的假 script 不该被当成真脚本）。
 */
function stripHtmlComments(input: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = input.indexOf('<!--', cursor);
    if (open === -1) {
      parts.push(input.slice(cursor));
      return parts.join('');
    }
    parts.push(input.slice(cursor, open));
    const close = input.indexOf('-->', open + 4);
    if (close === -1) {
      return parts.join('');
    }
    cursor = close + 3;
  }
}

function main(): void {
  const root = process.cwd();
  let html: string;
  let csp: string;
  try {
    html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8');
    csp = readFileSync(join(root, 'src/main/security/csp.ts'), 'utf8');
  } catch {
    console.error('[check-csp-hash] ❌ 无法读取 index.html / csp.ts');
    process.exit(1);
  }

  // 锚定 <head> 且先剥离 HTML 注释：裸 <script> 正则是惰性匹配，不锚定位置时注释里的
  // 裸 <script>（如注释掉的旧版主题脚本）会被误提取算旧 hash；旧 hash 若仍在 csp.ts 中，
  // 闸会静默放行真实失效，故必须先剥离注释
  const inline = stripHtmlComments(html).match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/);
  if (inline === null || inline[1] === undefined || inline[1].trim() === '') {
    console.error(
      '[check-csp-hash] ❌ index.html 缺失首帧主题内联脚本（裸 <script> 块）——防闪失效',
    );
    process.exit(1);
  }
  const scriptBody = inline[1];

  // 键名契约：脚本读取的 localStorage key 必须与 theme-init.ts mirrorThemeForFirstPaint 的
  // 写入点一致，任一侧改名即卡关
  if (!scriptBody.includes(`'${THEME_FIRST_PAINT_KEY}'`)) {
    console.error(
      `[check-csp-hash] ❌ 内联脚本未读取主题镜像键 '${THEME_FIRST_PAINT_KEY}'` +
        '（theme-init.ts 与 index.html 的键名契约断裂，首帧将回退默认主题）',
    );
    process.exit(1);
  }

  const hash = `sha256-${createHash('sha256').update(scriptBody, 'utf8').digest('base64')}`;
  if (!csp.includes(hash)) {
    console.error('[check-csp-hash] ❌ 内联脚本 hash 与 csp.ts 不一致——修改脚本后必须重算：');
    console.error(`  实际 hash：${hash}`);
    console.error('  修复：更新 src/main/security/csp.ts PRODUCTION_CSP 的 script-src hash 值');
    process.exit(1);
  }

  // 脚本执行前的首绘底色，也是脚本被 CSP 拦截时的最后防线
  if (!/<html[^>]*style="[^"]*background\s*:/.test(html)) {
    console.error(
      '[check-csp-hash] ❌ <html> 缺失 background 兜底 style——CSP/脚本异常时首帧回退白底闪烁',
    );
    process.exit(1);
  }

  // 断言缺失是为了防将来有人「补」meta 导致策略分叉：唯一执行点是 applyCspToSession 的
  // onHeadersReceived 注入——meta 不支持 frame-ancestors，且与响应头形成双真源漂移
  if (/http-equiv=["']?Content-Security-Policy/i.test(html)) {
    console.error('[check-csp-hash] ❌ index.html 出现 CSP meta——与响应头注入形成双真源漂移：');
    console.error('  唯一策略源是 src/main/security/csp.ts（applyCspToSession 注入），删除该 meta');
    process.exit(1);
  }

  console.log('[check-csp-hash] ✅ 通过：首帧脚本 hash 与 CSP 一致，键名契约与兜底背景在位');
}

main();
