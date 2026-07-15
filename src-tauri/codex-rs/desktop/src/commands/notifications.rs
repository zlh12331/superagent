//! 原生通知命令。
//!
//! 使用 Tauri notification 插件提供跨平台原生通知能力。

use tauri::AppHandle;

use crate::error::AppError;

/// 发送原生系统通知。
/// 在移动平台上会返回错误，因为暂不支持通知。
#[tauri::command]
#[specta::specta]
pub async fn send_native_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), AppError> {
    // 校验输入
    if title.is_empty() {
        return Err(AppError::validation("Notification title cannot be empty"));
    }
    if title.chars().count() > 200 {
        return Err(AppError::validation(
            "Notification title too long (max 200 characters)",
        ));
    }
    if let Some(b) = &body
        && b.chars().count() > 500
    {
        return Err(AppError::validation(
            "Notification body too long (max 500 characters)",
        ));
    }

    log::info!("Sending native notification: {title}");

    #[cfg(not(mobile))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut notification = app.notification().builder().title(title);

        if let Some(body_text) = body {
            notification = notification.body(body_text);
        }

        match notification.show() {
            Ok(_) => {
                log::info!("Native notification sent successfully");
                Ok(())
            }
            Err(e) => {
                log::error!("Failed to send native notification: {e}");
                Err(AppError::notification(format!(
                    "Failed to send notification: {e}"
                )))
            }
        }
    }

    #[cfg(mobile)]
    {
        let _ = (app, body);
        log::warn!("Native notifications not supported on mobile");
        Err(AppError::notification(
            "Native notifications not supported on mobile".to_string(),
        ))
    }
}
