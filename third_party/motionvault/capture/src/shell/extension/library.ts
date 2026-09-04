/**
 * library.ts —— MotionLens 本地灵感库面板。
 * 数据源：chrome.storage.local 中 ml_item_ 前缀条目。
 * 功能：卡片列表（title/category/域名/时间/confidence，unanalyzed 显示「仅提取数据」）、
 *      展开看 principle + 中英 prompt + 复制；导出 EffectDraft[] JSON；清空；搜索过滤。
 */
import type { EffectDraft } from '../../core/types';

declare const chrome: any;

const ITEM_PREFIX = 'ml_item_';

interface StoredItem {
  id: string;
  savedAt: string;
  domain: string;
  unanalyzed?: boolean;
  error?: string;
  draft?: EffectDraft;
  report?: { url?: string };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let items: StoredItem[] = [];
let query = '';

async function loadItems(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  items = Object.keys(all)
    .filter((k) => k.startsWith(ITEM_PREFIX))
    .map((k) => all[k] as StoredItem)
    .sort((a, b) => b.id.localeCompare(a.id)); // key 以时间戳开头，倒序即最新在前
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s: string): string {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function matches(it: StoredItem): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (it.draft?.title ?? '').toLowerCase().includes(q) ||
    (it.draft?.titleEn ?? '').toLowerCase().includes(q) ||
    it.domain.toLowerCase().includes(q)
  );
}

function render(): void {
  const list = $('list');
  const visible = items.filter(matches);
  if (visible.length === 0) {
    list.innerHTML = `<p class="empty">${items.length === 0 ? '还没有捕捉任何动效。点击扩展图标 → 🎯 捕捉动效。' : '没有匹配的条目。'}</p>`;
    return;
  }
  list.innerHTML = '';
  for (const it of visible) {
    list.appendChild(renderCard(it));
  }
}

function renderCard(it: StoredItem): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';

  const d = it.draft;
  const title = d ? `${esc(d.title)} <span style="color:#a1a1aa;font-weight:400">${esc(d.titleEn)}</span>` : '未分析条目';
  const badges = d
    ? `<span class="badge">${esc(d.category)}</span><span class="badge">${esc(d.difficulty)}</span>`
    : '<span class="badge raw">仅提取数据</span>';
  const conf = d ? `<span class="conf">置信 ${(d.confidence * 100).toFixed(0)}%</span>` : '';

  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `
    <span class="title">${title}</span>
    ${badges}
    <span class="meta">${conf}<span>${esc(it.domain)}</span><span>${fmtTime(it.savedAt)}</span></span>`;
  head.addEventListener('click', () => card.classList.toggle('open'));
  card.appendChild(head);

  const detail = document.createElement('div');
  detail.className = 'detail';
  if (d) {
    detail.innerHTML = `
      <h3>原理</h3><p>${esc(d.principle)}</p>
      <h3>描述</h3><p>${esc(d.description)} · 标签：${esc(d.techTags.join(', '))}</p>
      <h3>中文 Prompt</h3><div class="prompt-box" data-prompt="zh">${esc(d.prompt)}</div>
      <div class="copy-row"><button class="btn copy-btn" data-target="zh">复制中文 Prompt</button></div>
      <h3>English Prompt</h3><div class="prompt-box" data-prompt="en">${esc(d.promptEn)}</div>
      <div class="copy-row"><button class="btn copy-btn" data-target="en">Copy English Prompt</button></div>
      <h3>来源</h3><a class="src-link" href="${esc(d.sourceUrl)}" target="_blank" rel="noreferrer">${esc(d.sourceUrl)}</a>`;
  } else {
    detail.innerHTML = `
      ${it.error ? `<h3>分析失败原因</h3><p>${esc(it.error)}</p>` : ''}
      <h3>原始报告</h3>
      <div class="prompt-box" data-prompt="raw">${esc(JSON.stringify(it.report ?? {}, null, 2))}</div>
      <div class="copy-row"><button class="btn copy-btn" data-target="raw">复制原始数据</button></div>
      ${it.report?.url ? `<h3>来源</h3><a class="src-link" href="${esc(it.report.url)}" target="_blank" rel="noreferrer">${esc(it.report.url)}</a>` : ''}`;
  }
  detail.addEventListener('click', (e) => e.stopPropagation());
  detail.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.target ?? '';
      const box = detail.querySelector(`[data-prompt="${key}"]`);
      const text = box?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
      } catch {
        btn.textContent = '复制失败';
      }
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = key === 'en' ? 'Copy English Prompt' : key === 'raw' ? '复制原始数据' : '复制中文 Prompt';
      }, 1600);
    });
  });
  card.appendChild(detail);
  return card;
}

function exportAll(): void {
  // 数组格式对齐 EffectDraft[]；unanalyzed 条目无 draft，跳过
  const drafts = items.filter((it) => it.draft).map((it) => it.draft);
  const blob = new Blob([JSON.stringify(drafts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'motionlens-library.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearAll(): Promise<void> {
  if (items.length === 0) return;
  if (!confirm(`确定清空全部 ${items.length} 条灵感记录？此操作不可恢复。`)) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(ITEM_PREFIX));
  await chrome.storage.local.remove(keys);
  items = [];
  render();
}

function main(): void {
  $('search').addEventListener('input', (e) => {
    query = (e.target as HTMLInputElement).value.trim();
    render();
  });
  $('export').addEventListener('click', exportAll);
  $('clear').addEventListener('click', () => void clearAll());
  void loadItems().then(render);
}

main();
