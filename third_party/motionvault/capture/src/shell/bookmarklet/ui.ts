/**
 * ui.ts —— MotionLens bookmarklet 的 Shadow DOM 浮动面板。
 *
 * 样式隔离策略：
 * - 宿主 div 内联样式 + attachShadow({ mode: 'closed' })，shadow 内自带 <style>，
 *   宿主页 CSS 进不来（继承属性在 shadow 内全部显式重置），面板样式也不会泄漏出去。
 * - 宿主 div 自身 pointer-events:none 全屏铺满，卡片 pointer-events:auto，
 *   因此面板外的页面交互不受影响。
 *
 * 设计语言对齐 MotionVault：白底、zinc 色系、12px 圆角、Inter/系统字体、极简。
 */
import type { CaptureReport, EffectDraft } from '../../core/types';
import type { BookmarkletSettings, Provider } from './settings';

const Z_INDEX = '2147483647';

const SHADOW_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .card {
    position: absolute; width: 392px; max-width: calc(100vw - 24px);
    max-height: min(72vh, 640px); display: flex; flex-direction: column;
    background: #ffffff; color: #18181b; border-radius: 12px;
    border: 1px solid #e4e4e7;
    box-shadow: 0 12px 40px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
    font: 13px/1.55 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden; pointer-events: auto;
  }
  .header {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    border-bottom: 1px solid #f4f4f5; cursor: grab; user-select: none;
    background: #ffffff; flex: none;
  }
  .header.dragging { cursor: grabbing; }
  .logo { font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
  .logo .dot { color: #4f8cff; margin-right: 5px; }
  .subtitle { color: #a1a1aa; font-size: 11px; }
  .close {
    margin-left: auto; width: 24px; height: 24px; border: none; border-radius: 6px;
    background: transparent; color: #71717a; font-size: 15px; line-height: 1;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .close:hover { background: #f4f4f5; color: #18181b; }
  .tabs { display: flex; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid #f4f4f5; flex: none; }
  .tab {
    border: none; background: transparent; color: #71717a; font: inherit;
    padding: 6px 10px 8px; cursor: pointer; border-radius: 6px 6px 0 0;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tab:hover { color: #18181b; }
  .tab.active { color: #18181b; font-weight: 600; border-bottom-color: #18181b; }
  .content { padding: 14px; overflow-y: auto; flex: 1 1 auto; min-height: 60px; }
  .content::-webkit-scrollbar { width: 8px; }
  .content::-webkit-scrollbar-thumb { background: #e4e4e7; border-radius: 4px; }

  h3 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; margin-bottom: 6px; }
  .muted { color: #71717a; }
  .small { font-size: 11.5px; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
    background: #f4f4f5; color: #52525b; border: 1px solid #e4e4e7; margin-right: 4px;
  }
  .badge.accent { background: rgba(79,140,255,0.1); color: #2f6de0; border-color: rgba(79,140,255,0.3); }
  .section { margin-top: 14px; }
  .label { font-size: 11px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
  .block {
    position: relative; background: #fafafa; border: 1px solid #e4e4e7; border-radius: 8px;
    padding: 10px 12px; white-space: pre-wrap; word-break: break-word;
    font-size: 12.5px; max-height: 180px; overflow-y: auto;
  }
  .block::-webkit-scrollbar { width: 6px; }
  .block::-webkit-scrollbar-thumb { background: #e4e4e7; border-radius: 3px; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px; border: 1px solid #e4e4e7;
    background: #ffffff; color: #18181b; font: inherit; font-size: 12px;
    padding: 5px 12px; border-radius: 7px; cursor: pointer; transition: background 0.12s;
  }
  .btn:hover { background: #f4f4f5; }
  .btn.primary { background: #18181b; color: #ffffff; border-color: #18181b; }
  .btn.primary:hover { background: #27272a; }
  .btn.ok { color: #16a34a; border-color: #bbf7d0; background: #f0fdf4; }
  .btnrow { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .error-box {
    background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
    border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .info-box {
    background: #fafafa; border: 1px solid #e4e4e7; color: #52525b;
    border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 12px;
  }
  .anim-row {
    display: flex; gap: 8px; align-items: baseline; padding: 7px 0;
    border-bottom: 1px solid #f4f4f5; font-size: 12.5px;
  }
  .anim-row:last-child { border-bottom: none; }
  .anim-row .src { flex: none; }
  .anim-row .meta { color: #71717a; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
  .form-row { margin-bottom: 12px; }
  .form-row label { display: block; font-size: 12px; font-weight: 550; color: #3f3f46; margin-bottom: 4px; }
  .form-row input, .form-row select {
    width: 100%; border: 1px solid #e4e4e7; border-radius: 7px; padding: 7px 10px;
    font: inherit; font-size: 12.5px; color: #18181b; background: #ffffff; outline: none;
  }
  .form-row input:focus, .form-row select:focus { border-color: #4f8cff; box-shadow: 0 0 0 3px rgba(79,140,255,0.15); }
  .spinner {
    width: 26px; height: 26px; border-radius: 50%; margin: 22px auto 12px;
    border: 2.5px solid #e4e4e7; border-top-color: #4f8cff;
    animation: ml-spin 0.8s linear infinite;
  }
  @keyframes ml-spin { to { transform: rotate(360deg); } }
  .center { text-align: center; }
`;

type TabName = 'prompt' | 'data' | 'settings';

export interface ResultViewData {
  draft: EffectDraft | null;
  report: CaptureReport;
  /** analyzeCapture 失败信息：展示错误 + 降级展示提取数据 */
  analyzeError?: string;
}

export interface SettingsFormOptions {
  settings: BookmarkletSettings;
  onSave: (settings: BookmarkletSettings) => void;
  /** 首次无 key 时提供「跳过，仅提取数据」 */
  onSkip?: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

/** 复制到剪贴板：navigator.clipboard 优先，execCommand 兜底。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.append(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function makeCopyButton(label: string, getText: () => string): HTMLButtonElement {
  const btn = h('button', { class: 'btn' }, [label]);
  btn.addEventListener('click', () => {
    void copyText(getText()).then((ok) => {
      if (!ok) return;
      const prev = btn.textContent;
      btn.textContent = '✓ 已复制';
      btn.classList.add('ok');
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove('ok');
      }, 1500);
    });
  });
  return btn;
}

export class MotionLensPanel {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private cardEl: HTMLDivElement | null = null;
  private contentEl: HTMLDivElement | null = null;
  private tabBtns = new Map<TabName, HTMLButtonElement>();
  private activeTab: TabName = 'prompt';
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastResult: ResultViewData | null = null;
  private settingsForm: SettingsFormOptions | null = null;

  /** 面板被用户关闭（× 或 ESC）时的回调 */
  onClose: (() => void) | null = null;

  get isOpen(): boolean {
    return this.host !== null && this.host.isConnected;
  }

  /** 测试/调试钩子：返回 closed shadow root（宿主页面脚本无法经 host.shadowRoot 拿到） */
  getShadowRoot(): ShadowRoot | null {
    return this.shadow;
  }

  open(): void {
    if (this.isOpen) return;
    const host = document.createElement('div');
    host.setAttribute('data-motionlens-panel', '');
    host.style.cssText =
      `position:fixed;inset:0;z-index:${Z_INDEX};pointer-events:none;`;
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.append(style);

    const card = h('div', { class: 'card' });
    card.style.top = '72px';
    card.style.right = '24px';

    // ---- header（拖拽把手）----
    const header = h('div', { class: 'header' });
    const logo = h('span', { class: 'logo' });
    logo.append(h('span', { class: 'dot' }, ['◉']), 'MotionLens');
    const closeBtn = h('button', { class: 'close', title: '关闭 (ESC)' }, ['×']);
    closeBtn.addEventListener('click', () => this.close());
    header.append(logo, h('span', { class: 'subtitle' }, ['动效透镜']), closeBtn);
    this.bindDrag(header, card, closeBtn);

    // ---- tabs ----
    const tabs = h('div', { class: 'tabs' });
    const defs: Array<[TabName, string]> = [['prompt', 'Prompt'], ['data', '数据'], ['settings', '设置']];
    for (const [name, label] of defs) {
      const btn = h('button', { class: 'tab' }, [label]);
      btn.addEventListener('click', () => this.showTab(name));
      this.tabBtns.set(name, btn);
      tabs.append(btn);
    }

    const content = h('div', { class: 'content' });
    card.append(header, tabs, content);
    shadow.append(card);

    (document.body || document.documentElement).append(host);
    this.host = host;
    this.shadow = shadow;
    this.cardEl = card;
    this.contentEl = content;

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen && host.style.display !== 'none') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this.keyHandler, true);
  }

  close(): void {
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
    this.cardEl = null;
    this.contentEl = null;
    this.onClose?.();
  }

  /** picker 全屏点选期间临时隐藏（保留状态） */
  setHidden(hidden: boolean): void {
    if (this.host) this.host.style.display = hidden ? 'none' : '';
  }

  showTab(name: TabName): void {
    if (!this.isOpen) return;
    this.activeTab = name;
    for (const [n, btn] of this.tabBtns) btn.classList.toggle('active', n === name);
    if (name === 'settings') this.renderSettings();
    else if (name === 'data') this.renderData();
    else this.renderPrompt();
  }

  showLoading(msg = 'AI 分析中…'): void {
    this.setTabContent([
      h('div', { class: 'spinner' }),
      h('p', { class: 'center muted' }, [msg]),
    ]);
  }

  /** 全局异常兜底页 */
  showError(message: string, report?: CaptureReport | null): void {
    const children: Node[] = [
      h('div', { class: 'error-box' }, [`出错了：${message}`]),
    ];
    if (report) {
      this.lastResult = { draft: null, report, analyzeError: message };
      children.push(
        h('p', { class: 'muted small' }, ['已保留提取数据，可切换到「数据」标签页查看。']),
        h('div', { class: 'btnrow' }, [this.makeTabButton('查看提取数据', 'data')]),
      );
    }
    this.setTabContent(children);
  }

  showResult(data: ResultViewData): void {
    this.lastResult = data;
    this.showTab(data.draft ? 'prompt' : data.analyzeError ? 'prompt' : 'data');
  }

  showSettingsForm(opts: SettingsFormOptions): void {
    this.settingsForm = opts;
    this.showTab('settings');
  }

  // ---------------------------------------------------------------- renders

  private renderPrompt(): void {
    const data = this.lastResult;
    const children: Node[] = [];

    if (data?.analyzeError) {
      children.push(
        h('div', { class: 'error-box' }, [`AI 分析失败：${data.analyzeError}`]),
        h('p', { class: 'muted small' }, ['已降级为仅展示提取数据，可在「数据」标签页复制原始 JSON。']),
        h('div', { class: 'btnrow' }, [this.makeTabButton('查看提取数据', 'data')]),
      );
    }

    const draft = data?.draft ?? null;
    if (draft) {
      const titleRow = h('div', {}, [h('h3', {}, [draft.title])]);
      const badges = h('div', {}, [
        h('span', { class: 'badge accent' }, [draft.category]),
        h('span', { class: 'badge' }, [draft.difficulty]),
        ...draft.techTags.slice(0, 4).map((t) => h('span', { class: 'badge' }, [t])),
      ]);
      children.push(
        titleRow,
        badges,
        h('p', { class: 'muted small', style: 'margin-top:6px' }, [draft.description]),
        h('div', { class: 'section' }, [
          h('div', { class: 'label' }, ['原理拆解']),
          h('div', { class: 'block' }, [draft.principle]),
        ]),
        h('div', { class: 'section' }, [
          h('div', { class: 'label' }, ['复现 Prompt（中文）']),
          h('div', { class: 'block' }, [draft.prompt]),
          h('div', { class: 'btnrow' }, [makeCopyButton('复制中文 Prompt', () => draft.prompt)]),
        ]),
        h('div', { class: 'section' }, [
          h('div', { class: 'label' }, ['Reproduction Prompt (EN)']),
          h('div', { class: 'block' }, [draft.promptEn]),
          h('div', { class: 'btnrow' }, [makeCopyButton('复制英文 Prompt', () => draft.promptEn)]),
        ]),
      );
    } else if (!data?.analyzeError) {
      children.push(
        h('div', { class: 'info-box' }, [
          data
            ? '未配置 API Key，已跳过 AI 分析。可查看「数据」标签页复制结构化提取结果，或在「设置」中配置 Key 后重新捕捉。'
            : '尚未捕捉动效。',
        ]),
      );
    }
    this.setTabContent(children);
  }

  private renderData(): void {
    const data = this.lastResult;
    if (!data) {
      this.setTabContent([h('div', { class: 'info-box' }, ['尚未捕捉动效。'])]);
      return;
    }
    const { report, draft } = data;
    const children: Node[] = [];

    children.push(
      h('div', { class: 'label' }, [`提取到 ${report.animations.length} 条动画`]),
    );

    if (report.animations.length === 0) {
      children.push(h('div', { class: 'info-box' }, ['未提取到结构化动画。' +
        (report.sampled ? '已通过样式采样兜底（见 sampled 字段）。' : '')]));
    }

    const list = h('div', {});
    for (const a of report.animations) {
      const iter = a.timing.iterations === Infinity ? '∞' : `×${a.timing.iterations}`;
      const meta = [
        a.name ? `name:${a.name}` : null,
        `${a.timing.duration}ms`,
        a.timing.delay ? `delay:${a.timing.delay}ms` : null,
        a.timing.easing ?? null,
        iter,
        `trigger:${a.trigger}`,
      ].filter(Boolean).join(' · ');
      list.append(h('div', { class: 'anim-row' }, [
        h('span', { class: 'badge accent src' }, [a.source]),
        h('span', { class: 'meta' }, [meta]),
      ]));
    }
    children.push(list);

    if (report.sampled) {
      children.push(h('div', { class: 'section' }, [
        h('div', { class: 'label' }, ['样式采样兜底']),
        h('p', { class: 'muted small' }, [
          `${Object.keys(report.sampled.curve.channels).length} 条通道 · ` +
          `${report.sampled.segments.length} 个拟合片段 · ${report.sampled.curve.durationMs}ms @${report.sampled.curve.fps}fps`,
        ]),
      ]));
    }

    const btns = h('div', { class: 'btnrow' }, [
      makeCopyButton('复制 CaptureReport JSON', () => JSON.stringify(report, null, 2)),
    ]);
    if (draft) {
      btns.append(makeCopyButton('复制 EffectDraft JSON', () => JSON.stringify(draft, null, 2)));
    }
    children.push(h('div', { class: 'section' }, [btns]));

    this.setTabContent(children);
  }

  private renderSettings(): void {
    const opts = this.settingsForm;
    const s: BookmarkletSettings = opts?.settings ?? { provider: 'openai', apiKey: '' };
    const wrap = h('div', {});

    const providerSel = h('select', {});
    for (const p of ['openai', 'anthropic', 'openai-compatible'] as Provider[]) {
      const o = h('option', { value: p }, [p]);
      if (p === s.provider) o.selected = true;
      providerSel.append(o);
    }

    const keyInput = h('input', { type: 'password', placeholder: 'sk-...', autocomplete: 'off' });
    keyInput.value = s.apiKey;
    const modelInput = h('input', { type: 'text', placeholder: '默认 gpt-4o / claude-sonnet-4-5' });
    modelInput.value = s.model ?? '';
    const baseUrlInput = h('input', { type: 'text', placeholder: 'https://your-endpoint/v1' });
    baseUrlInput.value = s.baseUrl ?? '';

    const baseUrlRow = h('div', { class: 'form-row' }, [
      h('label', {}, ['Base URL（仅 openai-compatible）']),
      baseUrlInput,
    ]);
    const syncBaseUrl = (): void => {
      baseUrlRow.style.display = providerSel.value === 'openai-compatible' ? '' : 'none';
    };
    providerSel.addEventListener('change', syncBaseUrl);
    syncBaseUrl();

    const status = h('span', { class: 'muted small' }, []);
    const saveBtn = h('button', { class: 'btn primary' }, ['保存设置']);
    saveBtn.addEventListener('click', () => {
      const next: BookmarkletSettings = {
        provider: providerSel.value as Provider,
        apiKey: keyInput.value.trim(),
      };
      if (modelInput.value.trim()) next.model = modelInput.value.trim();
      if (baseUrlInput.value.trim()) next.baseUrl = baseUrlInput.value.trim();
      opts?.onSave(next);
    });

    wrap.append(
      h('div', { class: 'form-row' }, [h('label', {}, ['Provider']), providerSel]),
      h('div', { class: 'form-row' }, [h('label', {}, ['API Key（仅存本浏览器 localStorage）']), keyInput]),
      h('div', { class: 'form-row' }, [h('label', {}, ['Model（留空用默认）']), modelInput]),
      baseUrlRow,
      h('div', { class: 'btnrow' }, [saveBtn, status]),
    );

    if (opts?.onSkip) {
      const skip = h('button', { class: 'btn' }, ['跳过，仅提取数据']);
      skip.addEventListener('click', () => opts.onSkip?.());
      wrap.append(h('div', { class: 'btnrow' }, [skip]));
    }

    this.setTabContent([wrap]);

    // 供外部在保存后写状态（成功/失败）
    this.setSettingsStatus = (msg, ok) => {
      status.textContent = msg;
      status.style.color = ok ? '#16a34a' : '#b91c1c';
    };
  }

  /** renderSettings 后可用：显示保存反馈 */
  setSettingsStatus: (msg: string, ok: boolean) => void = () => undefined;

  // ---------------------------------------------------------------- internals

  private makeTabButton(label: string, tab: TabName): HTMLButtonElement {
    const btn = h('button', { class: 'btn' }, [label]);
    btn.addEventListener('click', () => this.showTab(tab));
    return btn;
  }

  private setTabContent(children: Node[]): void {
    if (!this.contentEl) return;
    this.contentEl.replaceChildren(...children);
    for (const [n, btn] of this.tabBtns) btn.classList.toggle('active', n === this.activeTab);
  }

  private bindDrag(header: HTMLDivElement, card: HTMLDivElement, closeBtn: HTMLButtonElement): void {
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let dragging = false;

    const onMove = (e: MouseEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 60;
      const left = Math.min(Math.max(baseLeft + dx, -card.offsetWidth + 60), maxLeft);
      const top = Math.min(Math.max(baseTop + dy, 0), maxTop);
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.right = 'auto';
    };
    const onUp = (): void => {
      dragging = false;
      header.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };

    header.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn || closeBtn.contains(e.target as Node)) return;
      dragging = true;
      header.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      const rect = card.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      card.style.left = `${baseLeft}px`;
      card.style.top = `${baseTop}px`;
      card.style.right = 'auto';
      e.preventDefault();
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    });
  }
}
