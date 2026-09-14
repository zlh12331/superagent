// scripts/check-csp-hash.ts
// 首帧防闪脚本 ↔ CSP hash 一致性闸（UI 与设计系统维度）
// ──────────────────────────────────────────────────────────────
// 背景：
// - index.html head 的首帧主题内联脚本被生产 CSP script-src 'sha256-…' 放行
//   （见 src/main/security/csp.ts PRODUCTION_CSP 注释）
// - 若修改脚本后忘记同步 hash：脚本被 CSP 静默拦截 → 防闪失效
//   （暗色用户首帧亮→暗闪），无任何报错——与 React Compiler 静默失效同款问题，
//   故设本闸（build/CI 卡关，check:compiler 同款防呆思想）
//
// 校验内容：
// 1. index.html 存在裸 <script>（无属性）内联块，非空
// 2. 其 sha256(base64) 出现在 csp.ts 的 script-src 指令中
// 3. <html> 标签带 background 兜底 style（脚本被拦截时的最后防线）
// ──────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THEME_FIRST_PAINT_KEY } from '../src/renderer/lib/theme-init';

/**
 * 剥离 HTML 注释（循环至收敛）
 *
 * 单遍 replace 不够：删除一个注释后，两侧残余字符可能重新拼出 `<!--`
 * （CodeQL js/incomplete-multi-character-sanitization 指出的不完整净化），
 * 于是注释内容仍会被后续正则当作真实标签匹配到。循环到不再变化为止，
 * 最后再删掉任何未闭合的 `<!--` 残片。
 */
function stripHtmlComments(input: string): string {
  let current = input;
  for (;;) {
    const next = current.replace(/<!--[\s\S]*?-->/g, '');
    if (next === current) {
      break;
    }
    current = next;
  }
  return current.replace(/<!--/g, '');
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

  // 1. 提取 head 内首个裸 <script> 内联块（首帧主题脚本；type="module" 的入口脚本带属性不匹配）
  //    锚定 <head> 并先剥离 HTML 注释：裸 <script> 的正则是惰性匹配（第一个开标签到最近的
  //    闭标签），但不锚定位置——若注释里出现裸 <script>（如注释掉旧版主题脚本），会误提旧
  //    脚本算出旧 hash，旧 hash 仍在 csp.ts 中 → 闸静默放行真实失效，故必须先剥离注释
  const inline = stripHtmlComments(html).match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/);
  if (inline === null || inline[1] === undefined || inline[1].trim() === '') {
    console.error(
      '[check-csp-hash] ❌ index.html 缺失首帧主题内联脚本（裸 <script> 块）——防闪失效',
    );
    process.exit(1);
  }
  const scriptBody = inline[1];

  // 1.5 键名契约：脚本读取的 localStorage key 必须与 TS 侧镜像写入点一致
  // （theme-init.ts mirrorThemeForFirstPaint 写入 ↔ 内联脚本读取，任一侧改名即卡关）
  if (!scriptBody.includes(`'${THEME_FIRST_PAINT_KEY}'`)) {
    console.error(
      `[check-csp-hash] ❌ 内联脚本未读取主题镜像键 '${THEME_FIRST_PAINT_KEY}'` +
        '（theme-init.ts 与 index.html 的键名契约断裂，首帧将回退默认主题）',
    );
    process.exit(1);
  }

  // 2. sha256 → 与 csp.ts 的 script-src hash 比对
  const hash = `sha256-${createHash('sha256').update(scriptBody, 'utf8').digest('base64')}`;
  if (!csp.includes(hash)) {
    console.error('[check-csp-hash] ❌ 内联脚本 hash 与 csp.ts 不一致——修改脚本后必须重算：');
    console.error(`  实际 hash：${hash}`);
    console.error('  修复：更新 src/main/security/csp.ts PRODUCTION_CSP 的 script-src hash 值');
    process.exit(1);
  }

  // 3. html 标签背景兜底（脚本执行前的首绘底色，脚本失效时的最后防线）
  if (!/<html[^>]*style="[^"]*background\s*:/.test(html)) {
    console.error(
      '[check-csp-hash] ❌ <html> 缺失 background 兜底 style——CSP/脚本异常时首帧回退白底闪烁',
    );
    process.exit(1);
  }

  console.log('[check-csp-hash] ✅ 通过：首帧脚本 hash 与 CSP 一致，键名契约与兜底背景在位');
}

main();
