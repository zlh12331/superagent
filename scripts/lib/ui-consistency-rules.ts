// scripts/lib/ui-consistency-rules.ts
// 渲染层写法一致性规则核（纯函数层，供 check-ui-consistency.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 从 check-ui-consistency.ts 抽出的原因：七条 error 级规则的判据（含豁免语义）
// 此前内联零测试（外部审计点名）。反例 fixture 测试见 ui-consistency-rules.test.ts
// ——每条规则都有「最小违规样本必须命中 + 干净/豁免样本必须放过」的双向断言。
//
// relFile 口径：posix 相对路径（CLI 侧 relative() 结果需统一转 '/'），
// 使 fileFilter 与平台无关。
// ──────────────────────────────────────────────────────────────

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
    // 限定 className 上下文：命令参数等业务拼接（如 args.join(' ')）不属样式
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
    // React Compiler 对含 try/finally 的函数**静默跳过**（bail-out），该组件失去自动
    // 记忆化——check:compiler 只断言产物整体生效，抓不到单个组件的 bail-out，
    // 故以静态信号兜住回归（2026-09-11）。
    desc: 'try/finally 语句（React Compiler 不优化，触发组件级 bail-out）——改为 catch 过后统一复位',
    // 只匹配语句形式 `} finally {`（Biome 固定此格式）；不匹配 Promise 的
    // `.finally(() => {`（那是合法用法，如 settings-store 的落库静默处理）
    pattern: /\}\s*finally\s*\{/,
  },
  {
    id: 'inline-query-key',
    // 规范：queryKey 必须是命名常量——域 hook（hooks/use-*.ts）内 export，或集中在
    // lib/query/keys.ts。内联使**失效点与查询点失去共享引用**，key 形状一变就静默失配。
    desc: '内联 queryKey 字面量（应引用命名常量：域 hook 内 export 或 lib/query/keys.ts）',
    pattern: /queryKey:\s*\[/,
    fileFilter: (relFile) => relFile !== 'lib/query/keys.ts',
  },
  {
    id: 'direct-ipc',
    // 规范：组件不直连 window.api——IPC 经域 hook 桥接（mock 可替换 + 契约测试可达）。
    // 边界（2026-09-24 定案）：hooks/*.ts 与 lib/*.ts 是桥接/工具层，直连是其职责，豁免；
    // 规则只管 .tsx 组件。
    desc: '组件直连 window.api（应经域 hook 桥接；hooks/lib 层豁免）',
    pattern: /\bwindow\.api\./,
    fileFilter: (relFile) => relFile.endsWith('.tsx'),
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
 * 扫描文件集，返回违规清单（逐文件 × 逐规则 × 逐行）
 *
 * 通用豁免（与 CLI 既有行为一致）：
 * - 纯注释行（// * /* 开头）跳过——注释里的示例不构成代码信号
 * - 上一行含 noArrayIndexKey biome-ignore → 跳过（index-key 规则的豁免）
 * - raw-button：起始块（回溯 3 行）内出现 styles/* 归属类名或
 *   aria-pressed/aria-selected/aria-expanded/role="tab" 语义 → 豁免
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
        // 跳过纯注释行：注释里的用法示例/反例说明不构成实际代码信号
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        // 上一行含 noArrayIndexKey biome-ignore 的豁免（与 Biome 同步）
        const prev = i > 0 ? (lines[i - 1] ?? '') : '';
        if (prev.includes('noArrayIndexKey')) {
          continue;
        }
        // raw-button 规则：检测当前按钮开标签块（回溯 3 行）内的归属类名/选择器语义
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
        violations.push({ rule: rule.id, file: relFile, line: i + 1 });
      }
    }
  }
  return violations;
}
