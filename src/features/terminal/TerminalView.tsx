/**
 * Terminal feature — xterm.js 单实例包装器
 *
 * 职责: 创建 Terminal 实例、挂载 FitAddon/WebLinksAddon、
 * ResizeObserver 自动 fit、用户输入转发、PTY 输出监听。
 * 浏览器 mock 模式下实现简单的命令模拟终端。
 */

import { useRef, useEffect, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { UnlistenFn } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import type { TerminalSession } from './types'
import { useTerminalStore } from './terminal-store'
import {
  startTerminalSession,
  writeToTerminal,
  resizeTerminalSession,
  terminateTerminalSession,
  onTerminalOutput,
} from '@/lib/codex/command_exec'

interface TerminalViewProps {
  /** 当前 Tab 对应的会话数据 */
  session: TerminalSession
}

/**
 * P0 修复：从 CSS 变量读取 xterm 主题配色（对齐原型 .term-body 使用 var(--bg) 等变量）。
 *
 * xterm.js 渲染到 canvas，theme 属性需要实际颜色值（hex/rgb），不能直接用 CSS 变量引用。
 * 因此在组件挂载时通过 getComputedStyle 读取当前主题的 CSS 变量值。
 *
 * 读取失败时回退到深色主题默认值（保证健壮性）。
 */
function readThemeFromCSSVariables(): Record<string, string> {
  // 在 SSR 或非浏览器环境下降级为默认深色主题
  if (typeof document === 'undefined') {
    return {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#e6edf3',
      selectionBackground: 'rgba(56,139,253,0.3)',
      black: '#0d1117',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e6edf3',
    }
  }
  const root = document.documentElement
  const style = getComputedStyle(root)
  // 读取变量，去空格，读不到时用 fallback
  const get = (varName: string, fallback: string): string => {
    const val = style.getPropertyValue(varName).trim()
    return val || fallback
  }
  return {
    background: get('--bg', '#0d1117'),
    foreground: get('--text', '#e6edf3'),
    cursor: get('--text', '#e6edf3'),
    selectionBackground: 'rgba(56,139,253,0.3)',
    black: get('--bg', '#0d1117'),
    red: get('--error', '#f87171'),
    green: get('--success', '#4ade80'),
    yellow: get('--warn', '#facc15'),
    blue: get('--accent-2', '#60a5fa'),
    magenta: '#c084fc',
    cyan: get('--accent', '#22d3ee'),
    white: get('--text', '#e6edf3'),
  }
}

/**
 * ANSI 颜色码常量（用于 mock 终端输出着色）。
 *
 * 仅在浏览器 mock 模式下使用，Tauri 模式下后端 PTY 自带颜色码。
 */
const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
} as const

/**
 * TerminalView 组件 —— xterm.js 单实例包装器。
 *
 * 职责：
 *  - 创建 xterm.js Terminal 实例并挂载 FitAddon / WebLinksAddon
 *  - 通过 ResizeObserver 自动 fit 到容器尺寸
 *  - Tauri 模式：启动 PTY 会话，转发用户输入，监听 PTY 输出
 *  - 浏览器 mock 模式：实现简单命令模拟终端（cargo / git / ls 等）
 *
 * 状态依赖：
 *  - 通过 props 接收 session（含 id / cwd / shell）
 *  - 从 useTerminalStore 获取 updateSession 方法，PTY 启动后回写 processId 与 status
 *
 * 副作用（在 useEffect 中执行）：
 *  1. 创建 Terminal + FitAddon + WebLinksAddon 并 open 到容器
 *  2. requestAnimationFrame 初始 fit
 *  3. 注册 ResizeObserver：尺寸变化时 fit + 通知后端 resize
 *  4. 调用 startTerminalSession 启动后端 PTY
 *  5. 根据 pid 前缀判断：
 *     - 'mock-' 前缀 → 进入 mock 终端模式（setupMockTerminal）
 *     - 其他 → 注册 onData 转发输入 + onTerminalOutput 接收输出
 *  6. 清理：dispose terminal / disconnect observer / unlisten event / terminate session
 *
 * 设计决策：
 *  - 所有副作用集中在 useEffect，依赖 [sessionId, sessionCwd, sessionShell, updateSession]
 *  - 使用 disposed 守卫防止异步回调在组件卸载后写入
 *  - mock 终端支持命令历史（ArrowUp/Down 浏览）、Ctrl+C/L、Backspace 等基础交互
 *
 * @param props —— 见 TerminalViewProps 接口
 */
export function TerminalView({ session }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const processIdRef = useRef<string | null>(null)
  // P0 修复：跟踪终端焦点状态（对齐原型 .term-body.focused { box-shadow: inset 1px 0 0 0 var(--accent) }）
  const [focused, setFocused] = useState(false)
  const updateSession = useTerminalStore(s => s.updateSession)

  const { id: sessionId, cwd: sessionCwd, shell: sessionShell } = session

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let unlistenOutput: UnlistenFn | null = null

    // 创建终端实例
    // P0 修复（对齐原型 .term-body）：
    //   - font-size 12 → 11（原型 font-size:11px）
    //   - theme 从 CSS 变量动态读取（原型使用 var(--bg) 等变量）
    const term = new Terminal({
      fontFamily: "'Martian Mono', ui-monospace, monospace",
      fontSize: 11,
      theme: readThemeFromCSSVariables(),
      cursorBlink: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(container)

    // P0 修复：监听容器焦点变化（对齐原型 .term-body.focused 状态）
    //   xterm 类型定义中无 onFocusChange，改用容器的 focusin/focusout 事件
    //   获得焦点时添加 inset 左侧 accent 线条，失去焦点时移除
    const handleFocusIn = () => setFocused(true)
    const handleFocusOut = () => setFocused(false)
    container.addEventListener('focusin', handleFocusIn)
    container.addEventListener('focusout', handleFocusOut)

    // 初始 fit
    requestAnimationFrame(() => {
      if (!disposed) fitAddon.fit()
    })

    // ResizeObserver: 自动 fit + 通知后端 resize
    // 防重入：fit 会修改 container 内部 DOM 尺寸，可能再次触发 ResizeObserver，
    // 形成无限循环（表现为面板持续变宽）。通过比较容器实际像素尺寸避免冗余 fit。
    let lastWidth = container.clientWidth
    let lastHeight = container.clientHeight
    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return
      // 只在容器实际像素尺寸变化时才 fit，打破 fit→重渲染→ResizeObserver→fit 循环
      const currentWidth = container.clientWidth
      const currentHeight = container.clientHeight
      if (currentWidth === lastWidth && currentHeight === lastHeight) return
      lastWidth = currentWidth
      lastHeight = currentHeight
      const oldCols = term.cols
      const oldRows = term.rows
      fitAddon.fit()
      if (term.cols !== oldCols || term.rows !== oldRows) {
        const pid = processIdRef.current
        if (pid) {
          resizeTerminalSession(pid, term.cols, term.rows)
        }
      }
    })
    resizeObserver.observe(container)

    // 浏览器 Mock 终端
    function setupMockTerminal(): void {
      let inputBuffer = ''
      const history: string[] = []
      let historyIndex = -1
      let cwd = sessionCwd

      const PROMPT = `${ANSI.cyan}$${ANSI.reset} `

      function writePrompt(): void {
        term.write(PROMPT)
      }

      function clearInputLine(): void {
        term.write('\r\x1b[K')
      }

      function rewriteInput(text: string): void {
        clearInputLine()
        term.write(PROMPT + text)
      }

      /**
       * 预填 mock 输出 — 对齐原型 3 个 Tab 的预设内容。
       *
       * 原型中每个终端 Tab 都有丰富的预置输出（编译日志、测试结果、git 状态），
       * 让用户切换到终端 tab 立即看到内容，而非空白。
       *
       * 根据 session.shell 类型选择不同的预设输出：
       * - zsh: cargo build --release + cargo test 输出
       * - cargo: cargo watch -x check 输出
       * - git: git status 输出
       */
      function writePresetOutput(): void {
        if (sessionShell === 'zsh') {
          term.writeln(`${ANSI.cyan}$${ANSI.reset} cargo build --release`)
          term.writeln('   Compiling codex-core v0.2.0 (codex-rs/core)')
          term.writeln('   Compiling codex-tui v0.2.0 (codex-rs/tui)')
          term.writeln('   Compiling superagent v0.2.0 (codex-rs/desktop)')
          term.writeln(`    ${ANSI.green}Finished${ANSI.reset} \`release\` profile [optimized] target(s) in 42.18s`)
          term.writeln('')
          term.writeln(`${ANSI.cyan}$${ANSI.reset} cargo test -p codex-core`)
          term.writeln('    Running unittests src/lib.rs (target/debug/deps/codex_core-...')
          term.writeln('test auth::tests::test_oauth_callback ... ok')
          term.writeln('test auth::tests::test_token_refresh ... ok')
          term.writeln('test auth::tests::test_state_validation ... ok')
          term.writeln(`test result: ${ANSI.green}ok${ANSI.reset}. 3 passed; 0 failed; 0 ignored; 0 measured`)
        } else if (sessionShell === 'cargo') {
          term.writeln(`${ANSI.cyan}$${ANSI.reset} cargo watch -x check`)
          term.writeln('    Checking codex-core v0.2.0 (codex-rs/core)')
          term.writeln(`    ${ANSI.green}Finished${ANSI.reset} \`dev\` profile [unoptimized] target(s) in 3.21s`)
          term.writeln(`[${ANSI.cyan}Waiting for changes...${ANSI.reset}]`)
        } else if (sessionShell === 'git') {
          term.writeln(`${ANSI.cyan}$${ANSI.reset} git status`)
          term.writeln(`On branch ${ANSI.green}feature/oauth-pkce${ANSI.reset}`)
          term.writeln("Your branch is ahead of 'origin' by 2 commits.")
          term.writeln('')
          term.writeln('Changes not staged for commit:')
          term.writeln(`  ${ANSI.red}modified:   src/auth/oauth.rs${ANSI.reset}`)
          term.writeln(`  ${ANSI.red}modified:   src/auth/token.rs${ANSI.reset}`)
          term.writeln(`  ${ANSI.green}new file:   src/auth/pkce.rs${ANSI.reset}`)
          term.writeln('')
          term.writeln('no changes added to commit')
        }
        term.writeln('')
      }

      function processCommand(cmd: string): string {
        const parts = cmd.trim().split(/\s+/)
        const c = parts[0] ?? ''
        const args = parts.slice(1).join(' ')

        if (c === '') return ''
        if (c === 'help') {
          return [
            `${ANSI.cyan}Available commands:${ANSI.reset}`,
            '  help              Show this help message',
            '  clear / cls       Clear terminal',
            '  ls                List files',
            '  pwd               Print working directory',
            '  cd <dir>          Change directory',
            '  echo <text>       Print text',
            '  date              Show current date',
            '  whoami            Show user',
            '  cargo ...         Cargo commands (build/test/check/run)',
            '  git ...           Git commands (status/log/diff/add/commit)',
          ].join('\r\n')
        }
        if (c === 'clear' || c === 'cls') {
          term.clear()
          return ''
        }
        if (c === 'ls' || c === 'dir') {
          return `${ANSI.green}core  tui  desktop  Cargo.toml  README.md  .git  target${ANSI.reset}`
        }
        if (c === 'pwd') {
          return cwd
        }
        if (c === 'whoami') {
          return 'developer'
        }
        if (c === 'date') {
          return new Date().toString()
        }
        if (c === 'echo') {
          return args
        }
        if (c === 'cd') {
          if (!args || args === '~' || args === '~/') {
            cwd = sessionCwd
          } else if (args === '..') {
            const p = cwd.split('/')
            if (p.length > 1) {
              p.pop()
              cwd = p.join('/') || '/'
            }
          } else {
            cwd = cwd + '/' + args.replace(/^\.\//, '').replace(/\/$/, '')
          }
          return ''
        }
        if (c === 'cargo') {
          const sub = parts[1] ?? ''
          if (sub === 'build') {
            return [
              '   Compiling codex-core v0.2.0 (codex-rs/core)',
              '   Compiling codex-tui v0.2.0 (codex-rs/tui)',
              `${ANSI.green}    Finished \`dev\` profile [unoptimized] target(s) in 3.42s${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'test') {
            return [
              'running 5 tests',
              'test auth::tests::oauth ... ok',
              `${ANSI.green}test result: ok. 5 passed; 0 failed${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'check') {
            return [
              `${ANSI.green}    Checking codex-core v0.2.0${ANSI.reset}`,
              `${ANSI.green}    Finished, no errors!${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'run') {
            return [
              '    Finished dev [unoptimized] target(s) in 0.12s',
              '     Running `target/debug/codex`',
              `${ANSI.cyan}Welcome to Codex v0.2.0${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'clean') {
            return 'Removed target directory.'
          }
          return 'Cargo subcommands: build, check, test, run, clean'
        }
        if (c === 'git') {
          const sub = parts[1] ?? ''
          if (sub === 'status') {
            return [
              'On branch main',
              "Your branch is up to date with 'origin/main'.",
              '',
              `${ANSI.green}nothing to commit, working tree clean${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'log') {
            return [
              'a1b2c3d feat: add terminal tabs',
              'e4f5g6h fix: sidebar overflow',
              'i7j8k9l refactor: cleanup dead code',
            ].join('\r\n')
          }
          if (sub === 'diff') {
            return [
              'diff --git a/src/main.rs b/src/main.rs',
              `${ANSI.green}+ println!("hello");${ANSI.reset}`,
            ].join('\r\n')
          }
          if (sub === 'add' || sub === 'commit') {
            return '(simulated)'
          }
          return 'Git commands: status, log, diff, add, commit'
        }
        return `${ANSI.red}command not found: ${c} (type "help" for available commands)${ANSI.reset}`
      }

      // 欢迎信息
      term.writeln(`${ANSI.cyan}Codex Terminal v0.2.0${ANSI.reset}`)
      term.writeln("Type 'help' for available commands.")
      // 预填 mock 输出（对齐原型 3 个 Tab 预设内容）
      writePresetOutput()
      writePrompt()

      term.onData((data: string) => {
        // Enter
        if (data === '\r') {
          term.write('\r\n')
          const cmd = inputBuffer
          if (cmd.trim()) history.push(cmd)
          historyIndex = -1
          inputBuffer = ''
          const output = processCommand(cmd)
          if (output) {
            term.write(output + '\r\n')
          }
          writePrompt()
          return
        }
        // Ctrl+C
        if (data === '\x03') {
          term.write('^C\r\n')
          inputBuffer = ''
          historyIndex = -1
          writePrompt()
          return
        }
        // Ctrl+L（清屏）
        if (data === '\x0c') {
          term.clear()
          writePrompt()
          return
        }
        // Backspace
        if (data === '\x7f') {
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1)
            term.write('\b \b')
          }
          return
        }
        // ArrowUp — 浏览命令历史
        if (data === '\x1b[A') {
          if (history.length === 0) return
          if (historyIndex === -1) {
            historyIndex = history.length - 1
          } else if (historyIndex > 0) {
            historyIndex--
          }
          const entry = history[historyIndex]
          if (entry !== undefined) {
            inputBuffer = entry
            rewriteInput(inputBuffer)
          }
          return
        }
        // ArrowDown — 浏览命令历史
        if (data === '\x1b[B') {
          if (historyIndex === -1) return
          historyIndex++
          if (historyIndex >= history.length) {
            historyIndex = -1
            inputBuffer = ''
          } else {
            const entry = history[historyIndex]
            if (entry !== undefined) {
              inputBuffer = entry
            }
          }
          rewriteInput(inputBuffer)
          return
        }
        // Tab (忽略)
        if (data === '\t') {
          return
        }
        // 可打印字符
        if (data.length > 0 && data.charCodeAt(0) >= 0x20) {
          inputBuffer += data
          term.write(data)
        }
      })
    }

    // 启动终端会话
    startTerminalSession(sessionCwd, sessionShell)
      .then(pid => {
        if (disposed) {
          terminateTerminalSession(pid)
          return
        }
        processIdRef.current = pid
        updateSession(sessionId, { processId: pid, status: 'running' })

        if (pid.startsWith('mock-')) {
          // 浏览器 Mock 终端
          setupMockTerminal()
        } else {
          // Tauri 终端
          term.writeln(`${ANSI.cyan}Codex Terminal v0.2.0${ANSI.reset}`)
          term.writeln("Type 'help' for available commands.")

          term.onData((data: string) => {
            writeToTerminal(pid, data)
          })

          onTerminalOutput(delta => {
            if (delta.processId === pid) {
              term.write(delta.data)
            }
          }).then(un => {
            if (disposed) {
              un()
            } else {
              unlistenOutput = un
            }
          }).catch((err: unknown) => {
            // 监听器注册失败时输出错误到终端，便于用户排查
            if (!disposed) {
              term.writeln(`${ANSI.red}Failed to listen terminal output: ${String(err)}${ANSI.reset}`)
            }
          })
        }
      })
      .catch((err: unknown) => {
        if (disposed) return
        term.writeln(
          `${ANSI.red}Failed to start terminal: ${String(err)}${ANSI.reset}`
        )
        updateSession(sessionId, { status: 'error' })
      })

    // 清理: dispose terminal, disconnect observer, unlisten event
    return () => {
      disposed = true
      container.removeEventListener('focusin', handleFocusIn)
      container.removeEventListener('focusout', handleFocusOut)
      if (unlistenOutput) unlistenOutput()
      resizeObserver.disconnect()
      const pid = processIdRef.current
      if (pid) terminateTerminalSession(pid)
      term.dispose()
      processIdRef.current = null
    }
  }, [sessionId, sessionCwd, sessionShell, updateSession])

  // P0 修复（对齐原型 .term-body + .term-instance）：
  //   - 补 flex-1 flex-col min-h-0 min-w-0（对齐 .term-instance { flex:1; flex-direction:column; min-height:0; min-width:0 }）
  //   - 补 px-2.5 py-2（对齐 .term-body { padding:8px 10px }）
  //   - 补 focused 状态 box-shadow（对齐 .term-body.focused { box-shadow: inset 1px 0 0 0 var(--accent) }）
  return (
    <div
      ref={containerRef}
      className={cn(
        'flex h-full w-full flex-1 flex-col overflow-hidden min-h-0 min-w-0 px-2.5 py-2',
        focused && 'shadow-[inset_1px_0_0_0_var(--accent)]'
      )}
    />
  )
}
