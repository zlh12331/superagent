use tauri_specta::{Builder, collect_commands};

pub fn generate_bindings() -> Builder<tauri::Wry> {
    use crate::commands::{
        account, approval, command_exec, config, crash_report, fs, mcp, notifications, plugin,
        preferences, process, quick_pane, recovery, thread, tray, turn,
    };

    Builder::<tauri::Wry>::new().commands(collect_commands![
        // === tauri-template 基础命令 ===
        preferences::greet,
        preferences::load_preferences,
        preferences::save_preferences,
        notifications::send_native_notification,
        recovery::save_emergency_data,
        recovery::load_emergency_data,
        recovery::cleanup_old_recovery_files,
        quick_pane::show_quick_pane,
        quick_pane::dismiss_quick_pane,
        quick_pane::toggle_quick_pane,
        quick_pane::get_default_quick_pane_shortcut,
        quick_pane::update_quick_pane_shortcut,
        tray::set_tray_icon_state,
        tray::move_window_to_tray,
        crash_report::read_crash_report,
        crash_report::delete_crash_report,
        crash_report::set_consent,
        // === codex-rs thread 域（36 个，对齐协议层全量命令） ===
        // 生命周期（4 + 7 = 11）
        thread::thread_start,
        thread::thread_list,
        thread::thread_read,
        thread::thread_unsubscribe,
        thread::thread_resume,
        thread::thread_fork,
        thread::thread_archive,
        thread::thread_unarchive,
        thread::thread_delete,
        thread::thread_rollback,
        thread::thread_set_name,
        // 元数据 + Goal（4）
        thread::thread_metadata_update,
        thread::thread_goal_set,
        thread::thread_goal_get,
        thread::thread_goal_clear,
        // 列表查询（5）
        thread::thread_loaded_list,
        thread::thread_search,
        thread::thread_turns_list,
        thread::thread_items_list,
        thread::thread_inject_items,
        // 操作（3）
        thread::thread_compact_start,
        thread::thread_shell_command,
        thread::thread_approve_guardian_denied_action,
        // Experimental（4）
        thread::thread_increment_elicitation,
        thread::thread_decrement_elicitation,
        thread::thread_settings_update,
        thread::thread_memory_mode_set,
        // Background Terminals（3，experimental）
        thread::thread_background_terminals_clean,
        thread::thread_background_terminals_list,
        thread::thread_background_terminals_terminate,
        // Realtime（6，experimental）
        thread::thread_realtime_start,
        thread::thread_realtime_append_audio,
        thread::thread_realtime_append_text,
        thread::thread_realtime_append_speech,
        thread::thread_realtime_stop,
        thread::thread_realtime_list_voices,
        // === codex-rs turn 域 ===
        turn::turn_start,
        turn::turn_steer,
        turn::turn_interrupt,
        // === codex-rs fs 域 ===
        fs::fs_read_file,
        fs::fs_write_file,
        fs::fs_create_directory,
        fs::fs_get_metadata,
        fs::fs_read_directory,
        fs::fs_remove,
        fs::fs_copy,
        fs::fs_watch,
        fs::fs_unwatch,
        // === codex-rs mcp 域 ===
        mcp::mcp_server_oauth_login,
        mcp::mcp_server_status_list,
        mcp::mcp_resource_read,
        mcp::mcp_server_tool_call,
        mcp::mcp_server_refresh,
        // === codex-rs config 域 ===
        config::config_read,
        config::config_value_write,
        config::config_batch_write,
        // === codex-rs account 域 ===
        account::login_account,
        account::cancel_login_account,
        account::logout_account,
        account::get_account,
        // === codex-rs command_exec 域 ===
        command_exec::command_exec,
        command_exec::command_exec_write,
        command_exec::command_exec_terminate,
        command_exec::command_exec_resize,
        // === codex-rs plugin 域 ===
        plugin::plugin_list,
        plugin::plugin_install,
        plugin::plugin_uninstall,
        plugin::plugin_read,
        // === codex-rs process 域 ===
        process::process_spawn,
        process::process_write_stdin,
        process::process_kill,
        process::process_resize_pty,
        // === codex-rs approval 域 ===
        // 审批响应：批准 / 拒绝 / 列出 pending 请求
        // 事件流：codex-rs ServerRequest → bridge::approval::register
        //         → emit("codex:approval:request") → 前端显示对话框
        //         → 用户响应 → approval_respond / approval_reject
        approval::approval_respond,
        approval::approval_reject,
        approval::approval_list_pending,
    ])
}

/// 将 TypeScript 绑定导出到 `1/src/lib/bindings.ts`（前端目录）。
///
/// 在独立线程中运行，使用稍大的栈空间（4MB，Windows 默认为 2MB），
/// 以确保 tauri-specta 类型图遍历过程中的安全性。
///
/// **路径说明**：`cargo test` 的工作目录是 `codex-rs/desktop/`（包根目录），
/// 因此前端目录 `1/src/lib/` 的相对路径是 `../../../src/lib/`：
/// - `../` → `codex-rs/`
/// - `../../` → `src-tauri/`
/// - `../../../` → `1/`（项目根目录）
/// - `../../../src/lib/bindings.ts` → `1/src/lib/bindings.ts`（前端）
///
/// **历史教训**：此前曾因 thread 域命令返回 `serde_json::Value`（递归类型）
/// 导致 specta TypeScript 代码生成栈溢出（即使 128MB 栈也不够）。根因修复
/// 方案是改返回 `String`（序列化后的 JSON），彻底消除了递归类型展开。
/// 详见 `commands/thread.rs` 模块文档。
#[allow(dead_code)] // only called by `cargo test export_bindings -- --ignored`
#[allow(clippy::expect_used)] // 绑定导出仅在开发时手动运行，失败应立即报错
pub fn export_ts_bindings() {
    std::thread::Builder::new()
        .stack_size(4 * 1024 * 1024) // 4 MB — 充足，无递归类型
        .spawn(|| {
            generate_bindings()
                .export(
                    specta_typescript::Typescript::default().header(
                        "// @ts-nocheck\n// Auto-generated by tauri-specta. DO NOT EDIT.\n\n",
                    ),
                    "../../../src/lib/bindings.ts",
                )
                .expect("Failed to export TypeScript bindings");
        })
        .expect("Failed to spawn bindings-export thread")
        .join()
        .expect("Bindings-export thread panicked");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成 TypeScript 绑定文件。
    /// 该测试默认被忽略，因此不会在 CI 中运行。
    /// 手动执行命令：cargo test export_bindings -- --ignored
    #[test]
    #[ignore]
    fn export_bindings() {
        export_ts_bindings();
        println!("✓ TypeScript bindings exported to ../../../src/lib/bindings.ts");
    }
}
