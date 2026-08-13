// src/renderer/lib/vim-mode.ts
// vim 模式纯逻辑（settings.editor.vimMode 的真实消费方——此前仅存储无行为）
// ──────────────────────────────────────────────────────────────
// 支持的 normal 模式命令（最小可用子集，设置页如实标注）：
//   移动：h/l 左右 · j/k 上下（保持列偏移）· w/b 词首 · 0/$ 行首尾
//   编辑：x 删光标处字符 · dd 删整行（d 进入命令缓冲等待第二键）
//   插入：i 光标处 / a 光标后 / I 行首 / A 行尾；Esc 回到 normal
// 不支持（如实声明）：数字前缀（3dd）、y/p 复制粘贴、v 可视模式、u 撤销。
// ──────────────────────────────────────────────────────────────

export type VimMode = 'normal' | 'insert';

export interface VimState {
  readonly mode: VimMode;
  /** normal 模式命令缓冲（'d' 等待第二键） */
  readonly pending: string;
}

export const INITIAL_VIM_STATE: VimState = { mode: 'normal', pending: '' };

export interface VimResult {
  /**
   * noop = 调用方按原逻辑处理（插入态普通按键放行 / normal 态未知按键拦截）
   * state = 仅模式/缓冲变化（Esc、d 首键）
   * move = 光标移动或进入插入（含目标光标位置）
   * edit = 文本替换（x / dd）
   */
  readonly type: 'noop' | 'state' | 'move' | 'edit';
  readonly state: VimState;
  /** move/edit：光标目标位置 */
  readonly cursor?: number;
  /** edit：替换后的全文 */
  readonly value?: string;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** 光标所在行边界（start 含，end 为行末字符后一位——不含换行符） */
function lineBounds(text: string, pos: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const newline = text.indexOf('\n', pos);
  const end = newline === -1 ? text.length : newline;
  return { start, end };
}

/** w：移动到下一词首（跳过当前词 → 跳过非词字符） */
function nextWordStart(text: string, pos: number): number {
  const len = text.length;
  let i = pos;
  while (i < len && isWordChar(text[i])) i += 1;
  while (i < len && !isWordChar(text[i])) i += 1;
  return i;
}

/** b：移动到上一词首 */
function prevWordStart(text: string, pos: number): number {
  let i = Math.max(0, pos - 1);
  while (i > 0 && !isWordChar(text[i])) i -= 1;
  while (i > 0 && isWordChar(text[i - 1])) i -= 1;
  return i;
}

/** j/k：上下行移动，保持当前行内列偏移 */
function moveVertical(text: string, pos: number, dir: 1 | -1): number {
  const { start, end } = lineBounds(text, pos);
  const offset = pos - start;
  if (dir === 1) {
    if (end >= text.length) return pos;
    const nextStart = end + 1;
    const nextNewline = text.indexOf('\n', nextStart);
    const nextEnd = nextNewline === -1 ? text.length : nextNewline;
    return nextStart + Math.min(offset, nextEnd - nextStart);
  }
  if (start === 0) return pos;
  const prevEnd = start - 1;
  const prevNewline = text.lastIndexOf('\n', prevEnd - 1);
  const prevStart = prevNewline === -1 ? 0 : prevNewline + 1;
  return prevStart + Math.min(offset, prevEnd - prevStart);
}

/** dd：删除光标所在行（含行尾换行符；最后一行只删内容） */
function deleteLine(text: string, pos: number): { value: string; cursor: number } {
  const { start, end } = lineBounds(text, pos);
  const removeEnd = end < text.length ? end + 1 : end;
  const value = text.slice(0, start) + text.slice(removeEnd);
  return { value, cursor: Math.min(start, value.length) };
}

/**
 * vim 按键处理（纯函数）
 *
 * @param state 当前 vim 状态（含 pending）
 * @param key KeyboardEvent.key
 * @param text 当前文本
 * @param cursor 当前光标位置（selectionStart）
 */
export function vimHandleKey(
  state: VimState,
  key: string,
  text: string,
  cursor: number,
): VimResult {
  const len = text.length;
  const pos = Math.max(0, Math.min(cursor, len));
  const noop: VimResult = { type: 'noop', state };

  // Esc：insert → normal；normal 下清除命令缓冲
  if (key === 'Escape') {
    return { type: 'state', state: { mode: 'normal', pending: '' } };
  }
  if (state.mode === 'insert') return noop;

  // 命令缓冲：d 等待第二键
  if (state.pending === 'd') {
    if (key === 'd') {
      const { value, cursor: next } = deleteLine(text, pos);
      return { type: 'edit', state: { mode: 'normal', pending: '' }, value, cursor: next };
    }
    // 非 dd：清除缓冲，继续按普通按键处理
    state = { mode: 'normal', pending: '' };
  }

  switch (key) {
    case 'd':
      return { type: 'state', state: { mode: 'normal', pending: 'd' } };
    case 'h':
      return { type: 'move', state, cursor: Math.max(0, pos - 1) };
    case 'l':
      return { type: 'move', state, cursor: Math.min(len, pos + 1) };
    case 'j':
      return { type: 'move', state, cursor: moveVertical(text, pos, 1) };
    case 'k':
      return { type: 'move', state, cursor: moveVertical(text, pos, -1) };
    case 'w':
      return { type: 'move', state, cursor: nextWordStart(text, pos) };
    case 'b':
      return { type: 'move', state, cursor: prevWordStart(text, pos) };
    case '0':
      return { type: 'move', state, cursor: lineBounds(text, pos).start };
    case '$':
      return { type: 'move', state, cursor: lineBounds(text, pos).end };
    case 'x': {
      const value = text.slice(0, pos) + text.slice(pos + 1);
      return { type: 'edit', state, value, cursor: Math.min(pos, value.length) };
    }
    case 'i':
      return { type: 'move', state: { mode: 'insert', pending: '' }, cursor: pos };
    case 'a':
      return {
        type: 'move',
        state: { mode: 'insert', pending: '' },
        cursor: Math.min(len, pos + 1),
      };
    case 'I':
      return {
        type: 'move',
        state: { mode: 'insert', pending: '' },
        cursor: lineBounds(text, pos).start,
      };
    case 'A':
      return {
        type: 'move',
        state: { mode: 'insert', pending: '' },
        cursor: lineBounds(text, pos).end,
      };
    default:
      return { type: 'noop', state };
  }
}
