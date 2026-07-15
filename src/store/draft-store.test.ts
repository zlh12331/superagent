import { describe, it, expect, beforeEach } from 'vitest'
import { useDraftStore } from './draft-store'

describe('DraftStore', () => {
  beforeEach(() => {
    // 每个测试前重置 store 状态
    useDraftStore.setState({ drafts: {} })
    // 清除持久化存储
    localStorage.clear()
  })

  // =========================================================================
  // 正向用例 — 初始状态
  // =========================================================================

  it('has empty drafts on init', () => {
    const state = useDraftStore.getState()
    expect(state.drafts).toEqual({})
  })

  it('exposes all action methods on the store', () => {
    const state = useDraftStore.getState()
    expect(typeof state.setDraft).toBe('function')
    expect(typeof state.getDraft).toBe('function')
    expect(typeof state.clearDraft).toBe('function')
    expect(typeof state.clearAllDrafts).toBe('function')
  })

  // =========================================================================
  // 正向用例 — setDraft / getDraft
  // =========================================================================

  it('sets and gets a draft by threadId', () => {
    useDraftStore.getState().setDraft('thread-1', 'hello world')
    expect(useDraftStore.getState().getDraft('thread-1')).toBe('hello world')
  })

  it('overwrites a previous draft for the same thread', () => {
    useDraftStore.getState().setDraft('thread-1', 'first')
    useDraftStore.getState().setDraft('thread-1', 'second')
    expect(useDraftStore.getState().getDraft('thread-1')).toBe('second')
  })

  it('manages drafts independently for different threads', () => {
    useDraftStore.getState().setDraft('thread-1', 'draft A')
    useDraftStore.getState().setDraft('thread-2', 'draft B')
    expect(useDraftStore.getState().getDraft('thread-1')).toBe('draft A')
    expect(useDraftStore.getState().getDraft('thread-2')).toBe('draft B')
  })

  // =========================================================================
  // 边界用例
  // =========================================================================

  it('getDraft returns empty string for unknown threadId', () => {
    expect(useDraftStore.getState().getDraft('nonexistent')).toBe('')
  })

  it('setDraft accepts empty string', () => {
    useDraftStore.getState().setDraft('thread-1', '')
    expect(useDraftStore.getState().getDraft('thread-1')).toBe('')
  })

  it('clearDraft on nonexistent thread does not throw', () => {
    expect(() =>
      useDraftStore.getState().clearDraft('nonexistent')
    ).not.toThrow()
  })

  // =========================================================================
  // 正向用例 — clearDraft
  // =========================================================================

  it('clears a specific draft without affecting others', () => {
    useDraftStore.getState().setDraft('thread-1', 'keep')
    useDraftStore.getState().setDraft('thread-2', 'remove')
    useDraftStore.getState().clearDraft('thread-2')

    expect(useDraftStore.getState().getDraft('thread-1')).toBe('keep')
    expect(useDraftStore.getState().getDraft('thread-2')).toBe('')
  })

  // =========================================================================
  // 正向用例 — clearAllDrafts
  // =========================================================================

  it('clears all drafts', () => {
    useDraftStore.getState().setDraft('thread-1', 'a')
    useDraftStore.getState().setDraft('thread-2', 'b')
    useDraftStore.getState().clearAllDrafts()

    expect(useDraftStore.getState().drafts).toEqual({})
    expect(useDraftStore.getState().getDraft('thread-1')).toBe('')
    expect(useDraftStore.getState().getDraft('thread-2')).toBe('')
  })

  // =========================================================================
  // 异常用例 — store 保持一致性
  // =========================================================================

  it('clearDraft does not affect unrelated drafts', () => {
    useDraftStore.getState().setDraft('thread-1', 'keep')
    useDraftStore.getState().setDraft('thread-2', 'remove')
    useDraftStore.getState().clearDraft('thread-2')

    const drafts = useDraftStore.getState().drafts
    expect(drafts['thread-1']).toBe('keep')
    expect(drafts['thread-2']).toBeUndefined()
  })

  // =========================================================================
  // persist middleware 集成
  // =========================================================================

  it('persists drafts to localStorage', () => {
    useDraftStore.getState().setDraft('thread-1', 'persisted')

    // 检查 localStorage 是否包含持久化状态
    const stored = localStorage.getItem('codex-draft-store')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored ?? '{}')
    expect(parsed.state?.drafts?.['thread-1']).toBe('persisted')
  })
})
