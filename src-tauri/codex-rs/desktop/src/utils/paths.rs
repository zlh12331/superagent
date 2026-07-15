//! 应用数据目录访问的共享路径工具。
//!
//! 提供解析应用数据目录内文件路径的辅助函数。
//! 目录创建与路径解析分离，使异步调用方可以将阻塞式的
//! `create_dir_all` 系统调用放入 `spawn_blocking` 中执行。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppError;

/// 解析应用数据目录中文件的路径，**不**创建目录。
///
/// 在异步上下文中调用是安全的——它仅从 Tauri `Manager` 读取路径，
/// 不执行任何文件系统 I/O。需要写文件的调用方应在 `spawn_blocking`
/// 闭包内调用 [`ensure_dir_exists`]。
///
/// # 参数
///
/// * `app` - Tauri 应用句柄
/// * `filename` - 应用数据目录中的文件名
///
/// # 错误
///
/// 如果无法解析应用数据目录路径，返回 `AppError`。
pub fn get_app_data_file_path<R: Runtime>(
    app: &AppHandle<R>,
    filename: &str,
) -> Result<PathBuf, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::path(format!("Failed to get app data directory: {e}")))?;

    Ok(app_data_dir.join(filename))
}

/// 确保目录存在，必要时创建它。
///
/// 这是一个阻塞式文件系统操作——异步上下文中的调用方应在
/// `spawn_blocking` 内调用它。
///
/// # 错误
///
/// 如果无法创建目录，返回 `AppError`。
pub fn ensure_dir_exists(dir: &std::path::Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::io(format!("Failed to create directory: {e}")))
}

/// 解析应用数据目录中文件的路径，并确保目录存在。
///
/// 为同步调用方提供的**便利封装**。异步 Tauri 命令应分别使用
/// [`get_app_data_file_path`] 和 [`ensure_dir_exists`]，后者需在
/// `spawn_blocking` 中执行。
///
/// # 错误
///
/// 如果无法解析或创建应用数据目录，返回 `AppError`。
pub fn get_app_data_file_path_sync<R: Runtime>(
    app: &AppHandle<R>,
    filename: &str,
) -> Result<PathBuf, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::path(format!("Failed to get app data directory: {e}")))?;

    ensure_dir_exists(&app_data_dir)?;

    Ok(app_data_dir.join(filename))
}
