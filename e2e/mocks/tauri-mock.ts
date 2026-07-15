/**
 * Tauri API mock for Playwright E2E tests.
 *
 * Injected via page.addInitScript() before any page scripts run.
 * Sets up window.__TAURI_INTERNALS__ with invoke and transformCallback
 * so all @tauri-apps/api/* and @tauri-apps/plugin-* modules work in a browser.
 */
export const tauriMockScript = `
(function () {
  // --- Callback registry for transformCallback ---
  var callbacks = {};
  var callbackId = 0;

  // --- Mock data store ---
  var mockPreferences = {
    theme: 'system',
    quick_pane_shortcut: null,
    language: null,
    crash_reporting_consent: null,
  };

  var crashReportData = null;
  var registeredChannels = [];
  var autostartEnabled = false;
  var invokeLog = [];

  // --- Codex mock data ---
  // Mock 线程列表（thread_start 时会 unshift 新线程）
  var mockThreads = [
    { id: 'thread-1', title: '重构 auth 模块', createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString() },
    { id: 'thread-2', title: '修复 Tauri v2 deep-link', createdAt: new Date(Date.now() - 7200000).toISOString(), updatedAt: new Date(Date.now() - 3600000).toISOString() },
  ];

  // --- transformCallback implementation ---
  function transformCallback(callback, once) {
    var id = ++callbackId;
    callbacks[id] = { callback: callback, once: once };
    return id;
  }

  // --- invoke implementation ---
  function invoke(cmd, args, options) {
    invokeLog.push(cmd);
    return new Promise(function (resolve, reject) {
      args = args || {};

      // --- User commands ---
      if (cmd === 'load_preferences') {
        resolve(mockPreferences);
        return;
      }
      if (cmd === 'save_preferences') {
        Object.assign(mockPreferences, args.preferences);
        resolve(null);
        return;
      }
      if (cmd === 'greet') {
        resolve('Hello, ' + args.name + '!');
        return;
      }
      if (cmd === 'read_crash_report') {
        resolve(crashReportData);
        return;
      }
      if (cmd === 'delete_crash_report') {
        crashReportData = null;
        resolve(null);
        return;
      }
      if (cmd === 'cleanup_old_recovery_files') {
        resolve(0);
        return;
      }
      if (cmd === 'get_default_quick_pane_shortcut') {
        resolve('CommandOrControl+Shift+.');
        return;
      }
      if (cmd === 'update_quick_pane_shortcut' || cmd === 'set_quick_pane_shortcut') {
        resolve(null);
        return;
      }
      if (cmd === 'register_quick_pane_shortcut' || cmd === 'unregister_quick_pane_shortcut') {
        resolve(null);
        return;
      }
      if (cmd === 'show_quick_pane' || cmd === 'dismiss_quick_pane' || cmd === 'toggle_quick_pane') {
        resolve(null);
        return;
      }
      if (cmd === 'set_tray_icon_state' || cmd === 'move_window_to_tray') {
        resolve(null);
        return;
      }
      if (cmd === 'send_native_notification') {
        resolve(null);
        return;
      }
      if (cmd === 'save_emergency_data' || cmd === 'load_emergency_data') {
        resolve(null);
        return;
      }

      // --- Plugin: event ---
      if (cmd === 'plugin:event|listen') {
        // Tauri 2.0 listen 传入 { event, target, handler }，其中
        // handler 是通过 transformCallback 注册的 callback ID。
        // 同时支持 legacy 的 channel 方式。
        var entry = { event: args.event, channel: null, handlerId: null };
        if (args.handler && typeof args.handler === 'number') {
          entry.handlerId = args.handler;
        }
        if (args.channel) {
          entry.channel = args.channel;
        }
        registeredChannels.push(entry);
        resolve(callbackId);
        return;
      }
      if (cmd === 'plugin:event|unlisten' || cmd === 'plugin:event|emit' || cmd === 'plugin:event|once') {
        resolve(null);
        return;
      }

      // --- Plugin: window ---
      if (cmd.indexOf('plugin:window|') === 0) {
        if (cmd.indexOf('is_fullscreen') !== -1) { resolve(false); return; }
        if (cmd.indexOf('is_maximized') !== -1) { resolve(false); return; }
        if (cmd.indexOf('is_visible') !== -1) { resolve(true); return; }
        if (cmd.indexOf('theme') !== -1) { resolve('light'); return; }
        if (cmd.indexOf('label') !== -1) { resolve('main'); return; }
        resolve(null);
        return;
      }

      // --- Plugin: webview ---
      if (cmd.indexOf('plugin:webview|') === 0) {
        resolve(null);
        return;
      }

      // --- Plugin: os ---
      if (cmd === 'plugin:os|locale') { resolve('en-US'); return; }
      if (cmd === 'plugin:os|platform') { resolve('windows'); return; }
      if (cmd.indexOf('plugin:os|') === 0) { resolve(null); return; }

      // --- Plugin: deep-link ---
      if (cmd === 'plugin:deep-link|get_current') { resolve([]); return; }
      if (cmd.indexOf('plugin:deep-link|') === 0) { resolve(null); return; }

      // --- Plugin: updater ---
      if (cmd === 'plugin:updater|check') { resolve(null); return; }
      if (cmd.indexOf('plugin:updater|') === 0) { resolve(null); return; }

      // --- Plugin: global-shortcut ---
      if (cmd.indexOf('plugin:global-shortcut|') === 0) { resolve(null); return; }

      // --- Plugin: autostart ---
      if (cmd === 'plugin:autostart|is_enabled') { resolve(autostartEnabled); return; }
      if (cmd === 'plugin:autostart|enable') { autostartEnabled = true; resolve(null); return; }
      if (cmd === 'plugin:autostart|disable') { autostartEnabled = false; resolve(null); return; }
      if (cmd.indexOf('plugin:autostart|') === 0) { resolve(null); return; }

      // --- Plugin: notification ---
      if (cmd.indexOf('plugin:notification|') === 0) { resolve(null); return; }

      // --- Plugin: menu ---
      if (cmd === 'plugin:menu|new') { resolve(1); return; }
      if (cmd.indexOf('plugin:menu|') === 0) { resolve(null); return; }

      // --- Plugin: log ---
      if (cmd.indexOf('plugin:log|') === 0) { resolve(null); return; }

      // --- Plugin: process ---
      if (cmd.indexOf('plugin:process|') === 0) { resolve(null); return; }

      // --- Plugin: clipboard-manager ---
      if (cmd.indexOf('plugin:clipboard-manager|') === 0) { resolve(null); return; }

      // --- Plugin: dialog ---
      if (cmd.indexOf('plugin:dialog|') === 0) { resolve(null); return; }

      // --- Plugin: fs ---
      if (cmd.indexOf('plugin:fs|') === 0) { resolve(null); return; }

      // --- Plugin: opener ---
      if (cmd.indexOf('plugin:opener|') === 0) { resolve(null); return; }

      // --- Codex: thread 域 ---
      // typedError() 已在 bindings.ts 中包装 { status: 'ok', data: T }，
      // 所以 mock invoke 只需返回原始数据（JSON 字符串）。
      // 错误时 reject(errorObject)，typedError 会包装为 { status: 'error', error: E }。
      if (cmd === 'thread_start') {
        var tsArgs = args.args || {};
        var newThread = {
          id: 'thread-' + Date.now(),
          title: tsArgs.cwd ? tsArgs.cwd.split('/').pop() + ' session' : 'New Session',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        mockThreads.unshift({
          id: newThread.id,
          title: newThread.title,
          createdAt: newThread.createdAt,
          updatedAt: newThread.updatedAt,
        });
        resolve(JSON.stringify({ thread: newThread, model: 'gpt-5', cwd: tsArgs.cwd || '' }));
        return;
      }
      if (cmd === 'thread_list') {
        resolve(JSON.stringify({ threads: mockThreads.slice(), nextCursor: null }));
        return;
      }
      if (cmd === 'thread_read') {
        var readArgs = args.args || {};
        var foundThread = mockThreads.find(function (t) { return t.id === readArgs.threadId; });
        if (foundThread) {
          resolve(JSON.stringify({ thread: foundThread }));
        } else {
          reject({ kind: 'NotFound', message: 'Thread not found: ' + readArgs.threadId });
        }
        return;
      }
      if (cmd === 'thread_unsubscribe') {
        resolve('null');
        return;
      }

      // --- Codex: turn 域 ---
      if (cmd === 'turn_start') {
        var newTurn = {
          id: 'turn-' + Date.now(),
          status: 'inProgress',
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: null,
        };
        resolve(JSON.stringify({ turn: newTurn }));
        return;
      }
      if (cmd === 'turn_steer') {
        resolve(JSON.stringify({ turnId: 'turn-' + Date.now() }));
        return;
      }
      if (cmd === 'turn_interrupt') {
        resolve('null');
        return;
      }

      // --- Codex: command_exec 域（终端 PTY） ---
      // startTerminalSession 在 Tauri 模式下客户端生成 proc-xxx 的 processId，
      // 调用 command_exec 只是通知后端启动 PTY 进程。
      // mock 返回一个确认字符串即可（startTerminalSession 不使用返回值，只检查错误）。
      if (cmd === 'command_exec') {
        resolve(JSON.stringify({ processId: args.processId || 'proc-mock', status: 'running' }));
        return;
      }
      // 写入终端 stdin — mock 下为 no-op
      if (cmd === 'command_exec_write') {
        resolve('null');
        return;
      }
      // 调整终端大小 — mock 下为 no-op
      if (cmd === 'command_exec_resize') {
        resolve('null');
        return;
      }
      // 终止终端会话 — mock 下为 no-op
      if (cmd === 'command_exec_terminate') {
        resolve('null');
        return;
      }

      // --- Codex: approval 域 ---
      // mock 下批准/拒绝直接返回成功（null 表示无返回值）
      // typedError 会包装为 { status: 'ok', data: null }
      if (cmd === 'approval_respond' || cmd === 'approval_reject') {
        resolve(null);
        return;
      }
      if (cmd === 'approval_list_pending') {
        resolve('[]');
        return;
      }

      // --- Default ---
      console.warn('[Tauri Mock] Unhandled command: ' + cmd);
      resolve(null);
    });
  }

  // --- Set up __TAURI_INTERNALS__ ---
  window.__TAURI_INTERNALS__ = {
    invoke: invoke,
    transformCallback: transformCallback,
    convertFileSrc: function (path) { return path; },
  };

  // --- Test helpers ---
  window.__testHelpers = {
    setCrashReport: function (data) { crashReportData = data; },
    getPreferences: function () { return JSON.parse(JSON.stringify(mockPreferences)); },
    setPreferences: function (prefs) { Object.assign(mockPreferences, prefs); },
    emitEvent: function (eventName, payload) {
      registeredChannels.forEach(function (entry) {
        if (entry.event === eventName) {
          var data = { event: eventName, payload: payload, id: 0 };
          // Tauri 2.0: handler 是来自 transformCallback 的 callback ID
          if (entry.handlerId != null && callbacks[entry.handlerId]) {
            callbacks[entry.handlerId].callback(data);
          }
          // Legacy: 直接 onmessage（原始 Channel 对象）
          else if (entry.channel && typeof entry.channel.onmessage === 'function') {
            entry.channel.onmessage(data);
          }
          // Legacy: 序列化的 Channel（带 callbackId）
          else if (entry.channel && entry.channel.callbackId && callbacks[entry.channel.callbackId]) {
            callbacks[entry.channel.callbackId].callback(data);
          }
        }
      });
    },
    getRegisteredChannels: function () {
      return registeredChannels.map(function (e) { return e.event; });
    },
    getInvokeLog: function () {
      return invokeLog.slice();
    },
    // --- Codex test helpers ---
    /** 获取当前 mock 线程列表（深拷贝，避免测试间状态污染） */
    getMockThreads: function () {
      return JSON.parse(JSON.stringify(mockThreads));
    },
    /** 重置 mock 线程列表为初始状态 */
    resetMockThreads: function () {
      mockThreads = [
        { id: 'thread-1', title: '重构 auth 模块', createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString() },
        { id: 'thread-2', title: '修复 Tauri v2 deep-link', createdAt: new Date(Date.now() - 7200000).toISOString(), updatedAt: new Date(Date.now() - 3600000).toISOString() },
      ];
    },
    /**
     * 发射 codex:approval:request 事件（模拟 codex-rs 审批请求）
     *
     * payload 结构与后端 bridge::mapper::ApprovalEventData 对齐：
     * - requestIdJson: RequestId 序列化后的 JSON 字符串（前端原样回传）
     * - requestIdDisplay: 用于 UI 显示的简短字符串
     * - approvalType: 审批类型（command / file_change / patch / permissions）
     * - payload: 请求内容（JSON 格式字符串）
     */
    emitApprovalRequest: function (payload) {
      var defaultPayload = {
        requestIdJson: JSON.stringify('approval-' + Date.now()),
        requestIdDisplay: 'approval-' + Date.now(),
        approvalType: 'command',
        payload: JSON.stringify({ command: 'ls -la' }),
      };
      registeredChannels.forEach(function (entry) {
        if (entry.event === 'codex:approval:request') {
          var data = { event: 'codex:approval:request', payload: Object.assign(defaultPayload, payload), id: 0 };
          if (entry.handlerId != null && callbacks[entry.handlerId]) {
            callbacks[entry.handlerId].callback(data);
          }
        }
      });
    },
    /** 发射 codex:notification 事件（模拟 codex-rs 消息通知） */
    emitCodexNotification: function (threadId) {
      registeredChannels.forEach(function (entry) {
        if (entry.event === 'codex:notification') {
          var data = { event: 'codex:notification', payload: { threadId: threadId, type: 'message' }, id: 0 };
          if (entry.handlerId != null && callbacks[entry.handlerId]) {
            callbacks[entry.handlerId].callback(data);
          }
        }
      });
    },
  };
})();
`
