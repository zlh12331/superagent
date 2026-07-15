//! 用于在 Windows 上 spawn 带 PTY 的 sandboxed processes 的 ConPTY 辅助函数。
//!
//! 本模块封装了 ConPTY 创建和 process spawn，以及所需的
//! `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 管道连接。它由 legacy
//! restricted-token path 和 elevated runner path 共享，当 unified_exec 以
//! `tty=true` 运行时使用。这些辅助函数不绑定到 IPC 层，可以被其他
//! 需要 PTY 的 Windows sandbox 流程复用。

use crate::desktop::LaunchDesktop;
use crate::proc_thread_attr::ProcThreadAttributeList;
use crate::winutil::format_last_error;
use crate::winutil::quote_windows_arg;
use crate::winutil::to_wide;
use anyhow::Context;
use anyhow::Result;
use codex_utils_pty::PsuedoCon;
use codex_utils_pty::RawConPty;
use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::io::IntoRawHandle;
use std::path::Path;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessAsUserW;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;

use crate::process::make_env_block;

/// 拥有一个 ConPTY handle 及其 backing pipe handles。
pub struct ConptyInstance {
    pseudoconsole: Option<PsuedoCon>,
    input_write: HANDLE,
    output_read: HANDLE,
    _desktop: Option<LaunchDesktop>,
}

impl Drop for ConptyInstance {
    fn drop(&mut self) {
        unsafe {
            if self.input_write != 0 && self.input_write != INVALID_HANDLE_VALUE {
                CloseHandle(self.input_write);
            }
            if self.output_read != 0 && self.output_read != INVALID_HANDLE_VALUE {
                CloseHandle(self.output_read);
            }
        }
        let _ = self.pseudoconsole.take();
    }
}

impl ConptyInstance {
    pub fn raw_handle(&self) -> Option<HANDLE> {
        self.pseudoconsole
            .as_ref()
            .map(|pseudoconsole| pseudoconsole.raw_handle() as HANDLE)
    }

    pub fn take_input_write(&mut self) -> HANDLE {
        std::mem::replace(&mut self.input_write, 0)
    }

    pub fn take_output_read(&mut self) -> HANDLE {
        std::mem::replace(&mut self.output_read, 0)
    }
}

/// 创建一个带 backing pipes 的 ConPTY。
///
/// 此函数为 public，以便需要 lower-level PTY setup 的调用方可以基于相同的
/// 原语构建，尽管常见的入口点是 `spawn_conpty_process_as_user`。
#[allow(dead_code)]
pub fn create_conpty(cols: i16, rows: i16) -> Result<ConptyInstance> {
    let raw = RawConPty::new(cols, rows)?;
    let (pseudoconsole, input_write, output_read) = raw.into_handles();

    Ok(ConptyInstance {
        pseudoconsole: Some(pseudoconsole),
        input_write: input_write.into_raw_handle() as HANDLE,
        output_read: output_read.into_raw_handle() as HANDLE,
        _desktop: None,
    })
}

/// 在 `h_token` 下 spawn 一个带 ConPTY 的 process。
///
/// 这是主要的共享 ConPTY 入口点，legacy/direct path 和
/// elevated runner path 在需要 PTY-backed sandboxed process 时都使用它。
pub fn spawn_conpty_process_as_user(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    use_private_desktop: bool,
    logs_base_dir: Option<&Path>,
) -> Result<(PROCESS_INFORMATION, ConptyInstance)> {
    let cmdline_str = argv
        .iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmdline: Vec<u16> = to_wide(&cmdline_str);
    let env_block = make_env_block(env_map);
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    let desktop = LaunchDesktop::prepare(use_private_desktop, logs_base_dir)?;
    si.StartupInfo.lpDesktop = desktop.startup_info_desktop();

    let raw = RawConPty::new(/*cols*/ 80, /*rows*/ 24)?;
    let (pseudoconsole, input_write, output_read) = raw.into_handles();
    let hpc = pseudoconsole.raw_handle() as HANDLE;
    let conpty = ConptyInstance {
        pseudoconsole: Some(pseudoconsole),
        input_write: input_write.into_raw_handle() as HANDLE,
        output_read: output_read.into_raw_handle() as HANDLE,
        _desktop: Some(desktop),
    };
    let mut attrs = ProcThreadAttributeList::new(/*attr_count*/ 1)?;
    attrs.set_pseudoconsole(hpc)?;
    si.lpAttributeList = attrs.as_mut_ptr();

    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessAsUserW(
            h_token,
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr() as *mut c_void,
            to_wide(cwd).as_ptr(),
            &si.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() } as i32;
        let message = format!(
            "CreateProcessAsUserW failed: {} ({}) | cwd={} | cmd={} | env_u16_len={}",
            err,
            format_last_error(err),
            cwd.display(),
            cmdline_str,
            env_block.len()
        );
        return Err(std::io::Error::from_raw_os_error(err)).context(message);
    }
    Ok((pi, conpty))
}
