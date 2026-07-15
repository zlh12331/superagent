// 在 Windows release 构建中隐藏额外的控制台窗口，切勿删除！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    codex_desktop_lib::run()
}
