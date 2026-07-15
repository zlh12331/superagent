import { describe, it, expect, beforeEach } from 'vitest'
import { useApprovalStore, type PendingApproval } from './approval-store'

describe('ApprovalStore', () => {
  beforeEach(() => {
    // 每个测试前重置 store 状态
    useApprovalStore.setState({
      pendingApproval: null,
      history: [],
    })
  })

  // =========================================================================
  // 正向用例 — 初始状态
  // =========================================================================

  it('has correct initial state', () => {
    const state = useApprovalStore.getState()
    expect(state.pendingApproval).toBe(null)
    expect(state.history).toEqual([])
  })

  it('exposes all action methods on the store', () => {
    const state = useApprovalStore.getState()
    expect(typeof state.setPendingApproval).toBe('function')
    expect(typeof state.approveCurrent).toBe('function')
    expect(typeof state.denyCurrent).toBe('function')
    expect(typeof state.clearCurrent).toBe('function')
  })

  // =========================================================================
  // 正向用例 — setPendingApproval
  // =========================================================================

  it('stores a pending approval request', () => {
    const approval: PendingApproval = {
      id: 'req-1',
      type: 'command',
      payload: 'npm install',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    expect(useApprovalStore.getState().pendingApproval).toEqual(approval)
  })

  it('overwrites the previous pending approval', () => {
    const first: PendingApproval = {
      id: 'req-1',
      type: 'command',
      payload: 'npm install',
      requestIdDisplay: '1',
      status: 'pending',
    }
    const second: PendingApproval = {
      id: 'req-2',
      type: 'patch',
      payload: '/src/main.rs',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(first)
    useApprovalStore.getState().setPendingApproval(second)
    expect(useApprovalStore.getState().pendingApproval).toEqual(second)
  })

  // =========================================================================
  // 正向用例 — approveCurrent
  // =========================================================================

  it('approves the current request and moves it to history', () => {
    const approval: PendingApproval = {
      id: 'req-1',
      type: 'command',
      payload: 'npm install',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    useApprovalStore.getState().approveCurrent()

    const state = useApprovalStore.getState()
    expect(state.pendingApproval).toBe(null)
    expect(state.history).toHaveLength(1)
    expect(state.history[0]?.status).toBe('approved')
    expect(state.history[0]?.id).toBe('req-1')
  })

  // =========================================================================
  // 正向用例 — denyCurrent
  // =========================================================================

  it('denies the current request and moves it to history', () => {
    const approval: PendingApproval = {
      id: 'req-2',
      type: 'patch',
      payload: '/src/main.rs',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    useApprovalStore.getState().denyCurrent()

    const state = useApprovalStore.getState()
    expect(state.pendingApproval).toBe(null)
    expect(state.history).toHaveLength(1)
    expect(state.history[0]?.status).toBe('denied')
  })

  // =========================================================================
  // 正向用例 — clearCurrent
  // =========================================================================

  it('clears current request without adding to history', () => {
    const approval: PendingApproval = {
      id: 'req-3',
      type: 'patch',
      payload: 'diff --git ...',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    useApprovalStore.getState().clearCurrent()

    const state = useApprovalStore.getState()
    expect(state.pendingApproval).toBe(null)
    expect(state.history).toEqual([])
  })

  // =========================================================================
  // 边界用例
  // =========================================================================

  it('approveCurrent with no pending approval does nothing', () => {
    useApprovalStore.getState().approveCurrent()
    expect(useApprovalStore.getState().pendingApproval).toBe(null)
    expect(useApprovalStore.getState().history).toEqual([])
  })

  it('denyCurrent with no pending approval does nothing', () => {
    useApprovalStore.getState().denyCurrent()
    expect(useApprovalStore.getState().pendingApproval).toBe(null)
    expect(useApprovalStore.getState().history).toEqual([])
  })

  it('accumulates multiple approvals in history', () => {
    const a1: PendingApproval = {
      id: 'req-1',
      type: 'command',
      payload: 'cmd1',
      requestIdDisplay: '1',
      status: 'pending',
    }
    const a2: PendingApproval = {
      id: 'req-2',
      type: 'command',
      payload: 'cmd2',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(a1)
    useApprovalStore.getState().approveCurrent()
    useApprovalStore.getState().setPendingApproval(a2)
    useApprovalStore.getState().denyCurrent()

    const state = useApprovalStore.getState()
    expect(state.history).toHaveLength(2)
    expect(state.history[0]?.id).toBe('req-1')
    expect(state.history[0]?.status).toBe('approved')
    expect(state.history[1]?.id).toBe('req-2')
    expect(state.history[1]?.status).toBe('denied')
  })

  // =========================================================================
  // 异常用例 — store 保持一致性
  // =========================================================================

  it('setPendingApproval does not affect history', () => {
    const approval: PendingApproval = {
      id: 'req-1',
      type: 'command',
      payload: 'cmd',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    expect(useApprovalStore.getState().history).toEqual([])
  })

  it('approveCurrent preserves original payload in history', () => {
    const approval: PendingApproval = {
      id: 'req-1',
      type: 'patch',
      payload: '/src/main.rs',
      requestIdDisplay: '1',
      status: 'pending',
    }
    useApprovalStore.getState().setPendingApproval(approval)
    useApprovalStore.getState().approveCurrent()

    const historyItem = useApprovalStore.getState().history[0]
    expect(historyItem?.payload).toBe('/src/main.rs')
    expect(historyItem?.type).toBe('file_change')
  })
})
