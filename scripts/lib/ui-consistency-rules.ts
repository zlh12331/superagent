// scripts/lib/ui-consistency-rules.ts
// 渲染层写法一致性规则核（纯函数层，供 check-ui-consistency.ts 调用；从 CLI 抽出
// 以补测试——外部审计点名判据内联零测试）。relFile 口径为 posix 相对路径（CLI 侧
// relative() 结果须统一转 '/'），fileFilter 与平台无关。豁免语义：纯注释行跳过 /
// 上一行 noArrayIndexKey 豁免 index-key / raw-button 看前后 ±3 行内的归属类名或
// aria 语义 / mutation-on-error 看选项块内有无 onError

export interface UiRule {
  readonly id: string;
  readonly desc: string;
  /** 命中计数正则（逐行匹配） */
  readonly pattern: RegExp;
  /** 适用文件过滤（posix 相对 src/renderer 的路径） */
  readonly fileFilter?: (relFile: string) => boolean;
}

export const UI_RULES: readonly UiRule[] = [
  {
    id: 'index-key',
    desc: '数组索引直接作 React key（骨架屏/静态拆分用上一行 biome-ignore noArrayIndexKey 豁免）',
    pattern: /key=\{(index|i|idx)\}/,
  },
  {
    id: 'join-class',
    desc: "className 内 join(' ') 手工拼接（条件类统一走 cn()）",
    pattern: /className.*\.join\(' '\)|\.join\(' '\).*"/,
    fileFilter: (relFile) => relFile.endsWith('.tsx'),
  },
  {
    id: 'manual-unwrap',
    desc: "手写 'data' in 判别解包 IPC 响应（统一 unwrap()，见 src/renderer/lib/ipc.ts）",
    pattern: /'data' in (res|response|result)\b/,
  },
  {
    id: 'raw-button',
    desc: 'components/** 内裸 <button>（应用 ui/button 的 Button；已归属 styles/ 领域按钮类的除外）',
    pattern: /<button\b/,
    fileFilter: (relFile) =>
      relFile.startsWith('components/') && !relFile.startsWith('components/ui/'),
  },
  {
    id: 'try-finally',
    desc: 'try/finally 语句（React Compiler 不优化，触发组件级 bail-out）——改为 catch 过后统一复位',
    pattern: /\}\s*finally\s*\{/,
  },
  {
    id: 'inline-query-key',
    desc: '内联 queryKey 字面量（应引用命名常量：域 hook 内 export 或 lib/query/keys.ts）',
    pattern: /queryKey:\s*\[/,
    fileFilter: (relFile) => relFile !== 'lib/query/keys.ts',
  },
  {
    id: 'direct-ipc',
    desc: '组件直连 window.api（应经域 hook 桥接；hooks/lib 层豁免）',
    pattern: /\bwindow\.api\./,
    fileFilter: (relFile) => relFile.endsWith('.tsx'),
  },
  {
    id: 'legacy-bridge-guard',
    desc: '旧式 window.api 可用性字面量判断（统一用 hasIpcBridge()，见 src/renderer/lib/ipc.ts）',
    pattern: /typeof window === 'undefined'\s*\|\|\s*window\.api === undefined/,
  },
  {
    id: 'raw-error-toast',
    desc: 'toast 直出 error.message（应经 unwrapErrorMessage(error, getErrorMessage) 本地化）',
    pattern: /toast\.error\(\s*error\.message\s*\)/,
    fileFilter: (relFile) => relFile.endsWith('.ts') || relFile.endsWith('.tsx'),
  },
  {
    id: 'mutation-on-error',
    desc: 'useMutation 选项缺 onError（写路径失败必须反馈；纯 toast 语义用 hooks/use-mutation-error）',
    pattern: /useMutation\b.*?\(\s*\{/,
  },
  {
    id: 'render-ref-write',
    desc: '渲染层直接写 xxxRef.current（统一 useLatestRef；effect 内写入走棘轮基线）',
    pattern: /\b\w+Ref\.current\s*=\s*(?!=)/,
    fileFilter: (relFile) => relFile !== 'hooks/use-latest-ref.ts',
  },
];

/**
 * 已归属 styles/ 领域按钮类的钮（icon-btn/tab/树节点/segmented 等
 * 有专属 CSS 类控制的场景），不属于 raw-button 规则目标。
 */
export const OWNED_CSS_BUTTON_CLASSES: readonly string[] = [
  'icon-btn',
  'sidebar-tab',
  'dev-sub-tab',
  'ft-row',
  'ft-dir',
  'ft-file',
  'sft-back',
  'sft-more-btn',
  'cpb-select',
  'model-item',
  'fdm-item',
  'fdm-action-btn',
  'fl-add-btn',
  'folder-label',
  'file-viewer-mode-btn',
  'file-viewer-save-btn',
  'file-viewer-copy-btn',
  'composer-tool-btn',
  'msg-action-btn',
  'card-head',
  'rh-chevron',
  'reasoning-head',
  'scroll-to-bottom',
  'jump-item',
  'ask-option',
  'fuzzy-result',
];

/** 扫描输入：posix 相对路径 + 按行拆分的内容 */
export interface UiScanFile {
  readonly relFile: string;
  readonly lines: readonly string[];
}

/** 单条违规（file 为 posix 相对路径，line 为 1-based 行号） */
export interface UiViolation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

/**
 * mutation-on-error 判据：自 `useMutation({` 命中行做花括号深度配对，
 * 定位选项对象块尾并返回块内代码（剔除纯注释行）。
 *
 * - 深度只数 `{`/`}`：选项对象内的嵌套函数体/模板插值天然配平，
 *   字符串内不配平括号属静态启发式的已知盲区（与 raw-button 同级取舍）
 * - 命中行自 `useMutation` 起计数——同一行前置的函数体开括号不参与配对
 * - 块未闭合（畸形代码）时退化为扫描至文件尾
 */
function findMutationOptionsCode(
  lines: readonly string[],
  start: number,
): {
  end: number;
  code: string;
} {
  let depth = 0;
  let end = lines.length - 1;
  for (let j = start; j < lines.length; j++) {
    const blockLine = lines[j];
    if (blockLine === undefined) break;
    const trimmed = blockLine.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    const countFrom =
      j === start ? blockLine.slice(Math.max(0, blockLine.indexOf('useMutation'))) : blockLine;
    for (const ch of countFrom) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) {
      end = j;
      break;
    }
  }
  const code = lines
    .slice(start, end + 1)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
  return { end, code };
}

/**
 * 扫描文件集，返回违规清单（逐文件 × 逐规则 × 逐行）
 *
 * 通用豁免（与 CLI 既有行为一致）：
 * - 纯注释行（// * /* 开头）跳过——注释里的示例不构成代码信号
 * - 上一行含 noArrayIndexKey biome-ignore → 跳过（index-key 规则的豁免）
 * - raw-button：起始块（回溯 3 行）内出现 styles/* 归属类名或
 *   aria-pressed/aria-selected/aria-expanded/role="tab" 语义 → 豁免
 * - mutation-on-error：useMutation 选项块内（剔除注释行）出现 onError → 豁免
 */
export function scanUiConsistency(files: readonly UiScanFile[]): UiViolation[] {
  const violations: UiViolation[] = [];
  for (const { relFile, lines } of files) {
    for (const rule of UI_RULES) {
      if (rule.fileFilter !== undefined && !rule.fileFilter(relFile)) {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || !rule.pattern.test(line)) {
          continue;
        }
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        // 上一行含 noArrayIndexKey biome-ignore 的豁免（与 Biome 同步）
        const prev = i > 0 ? (lines[i - 1] ?? '') : '';
        if (prev.includes('noArrayIndexKey')) {
          continue;
        }
        if (rule.id === 'raw-button') {
          const blockStart = Math.max(0, i - 3);
          const block = lines.slice(blockStart, i + 4).join('\n');
          if (OWNED_CSS_BUTTON_CLASSES.some((cls) => block.includes(cls))) {
            continue;
          }
          if (
            block.includes('aria-pressed=') ||
            block.includes('aria-selected=') ||
            block.includes('aria-expanded=') ||
            block.includes('role="tab"')
          ) {
            continue;
          }
        }
        if (rule.id === 'mutation-on-error') {
          const { end, code } = findMutationOptionsCode(lines, i);
          if (!/\bonError\s*[:,]/.test(code)) {
            violations.push({ rule: rule.id, file: relFile, line: i + 1 });
          }
          i = end;
          continue;
        }
        violations.push({ rule: rule.id, file: relFile, line: i + 1 });
      }
    }
  }
  return violations;
}
