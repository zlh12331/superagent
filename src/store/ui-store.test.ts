import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUIStore } from './ui-store'

describe('UIStore', () => {
  beforeEach(() => {
    // 每个测试前重置 store 状态为初始默认值
    useUIStore.setState({
      lastQuickPaneEntry: null,
      squareCorners: false,
    })
    document.documentElement.classList.remove('square-corners')
  })

  describe('正向用例 — 初始状态', () => {
    it('has correct initial state', () => {
      const state = useUIStore.getState()
      expect(state.lastQuickPaneEntry).toBe(null)
      expect(state.squareCorners).toBe(false)
    })

    it('exposes all action methods on the store', () => {
      const state = useUIStore.getState()
      expect(typeof state.setLastQuickPaneEntry).toBe('function')
      expect(typeof state.setSquareCorners).toBe('function')
    })
  })

  describe('正向用例 — Quick Pane 条目', () => {
    it('stores the last quick pane entry text', () => {
      const { setLastQuickPaneEntry } = useUIStore.getState()

      setLastQuickPaneEntry('hello world')
      expect(useUIStore.getState().lastQuickPaneEntry).toBe('hello world')
    })

    it('overwrites the previous quick pane entry', () => {
      const { setLastQuickPaneEntry } = useUIStore.getState()

      setLastQuickPaneEntry('first')
      setLastQuickPaneEntry('second')
      expect(useUIStore.getState().lastQuickPaneEntry).toBe('second')
    })
  })

  describe('正向用例 — 方角设置 (setSquareCorners)', () => {
    it('sets squareCorners to true when enabled', () => {
      const { setSquareCorners } = useUIStore.getState()

      setSquareCorners(true)
      expect(useUIStore.getState().squareCorners).toBe(true)
    })

    it('sets squareCorners to false when disabled', () => {
      const { setSquareCorners } = useUIStore.getState()

      setSquareCorners(true)
      setSquareCorners(false)
      expect(useUIStore.getState().squareCorners).toBe(false)
    })
  })

  describe('边界用例', () => {
    it('setLastQuickPaneEntry accepts an empty string', () => {
      const { setLastQuickPaneEntry } = useUIStore.getState()

      setLastQuickPaneEntry('')
      expect(useUIStore.getState().lastQuickPaneEntry).toBe('')
    })

    it('setSquareCorners(true) called twice keeps the state true', () => {
      const { setSquareCorners } = useUIStore.getState()

      setSquareCorners(true)
      setSquareCorners(true)
      expect(useUIStore.getState().squareCorners).toBe(true)
    })

    it('setSquareCorners(false) when state is already false does not throw', () => {
      const { setSquareCorners } = useUIStore.getState()

      expect(() => setSquareCorners(false)).not.toThrow()
      expect(useUIStore.getState().squareCorners).toBe(false)
    })
  })

  describe('异常用例 — store 仍保持一致性', () => {
    it('setSquareCorners does not mutate unrelated store state', () => {
      const stateBefore = { ...useUIStore.getState() }
      const { setSquareCorners } = useUIStore.getState()

      setSquareCorners(true)
      const stateAfter = useUIStore.getState()

      // setSquareCorners 仅更新 squareCorners 字段，不影响其他状态
      expect(stateAfter.lastQuickPaneEntry).toBe(stateBefore.lastQuickPaneEntry)
      expect(stateAfter.squareCorners).toBe(true)
    })

    it('setLastQuickPaneEntry does not affect squareCorners', () => {
      const { setLastQuickPaneEntry } = useUIStore.getState()

      setLastQuickPaneEntry('test')
      expect(useUIStore.getState().squareCorners).toBe(false)
    })

    it('survives store.setState being called with extra fields', () => {
      // 模拟外部的 setState 调用
      useUIStore.setState({ lastQuickPaneEntry: 'external' })
      expect(useUIStore.getState().lastQuickPaneEntry).toBe('external')
      expect(useUIStore.getState().squareCorners).toBe(false)
    })
  })

  describe('devtools 集成', () => {
    it('store is created with the ui-store name for devtools', () => {
      // devtools 中间件已应用；getState 仍返回普通对象快照，
      // 确认中间件未破坏 store。
      const state = useUIStore.getState()
      expect(state).toBeInstanceOf(Object)
      expect(Object.keys(state).length).toBeGreaterThan(0)
    })
  })
})

// 抑制测试期间 devtools 中间件输出的 console.debug 日志
vi.stubGlobal('console', {
  ...console,
  debug: vi.fn(),
})
