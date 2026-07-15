//! elevated Windows sandbox runner 的 named pipe 辅助函数。
//!
//! 本模块生成 paired pipe names，创建带有 sandbox-user-scoped ACLs 的
//! server-side pipes，并等待 runner 连接。该模块仅用于
//! **elevated-path only**，由 parent 用于为 unified-exec sessions
//! 和 elevated capture 建立 IPC channel。legacy restricted-token 路径直接
//! spawn child process，不使用这些辅助函数。

use crate::helper_materialization::HelperExecutable;
use crate::helper_materialization::resolve_helper_for_launch;
use crate::winutil::resolve_sid;
use crate::winutil::string_from_sid_bytes;
use crate::winutil::to_wide;
use rand::Rng;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::ptr;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
use windows_sys::Win32::System::Pipes::CreateNamedPipeW;
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::Pipes::PIPE_READMODE_BYTE;
use windows_sys::Win32::System::Pipes::PIPE_TYPE_BYTE;
use windows_sys::Win32::System::Pipes::PIPE_WAIT;

/// PIPE_ACCESS_INBOUND（win32 常量），在 windows-sys 0.52 中未暴露。
pub const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
/// PIPE_ACCESS_OUTBOUND（win32 常量），在 windows-sys 0.52 中未暴露。
pub const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;

/// 解析 elevated command runner 的路径，优先使用 `.sandbox-bin` 下复制的 helper，
/// 需要时回退到 legacy 的同级查找方式。
pub fn find_runner_exe(codex_home: &Path, log_dir: Option<&Path>) -> PathBuf {
    resolve_helper_for_launch(HelperExecutable::CommandRunner, codex_home, log_dir)
}

/// 生成一个唯一的 named-pipe 路径，用于与 runner process 通信。
/// 返回一对 paired pipe names（in 和 out），分别用于双向数据传输。
pub fn pipe_pair() -> (String, String) {
    let mut rng = SmallRng::from_entropy();
    let nonce: u128 = rng.r#gen();
    let base = format!(r"\\.\pipe\codex-runner-{nonce:x}");
    (format!("{base}-in"), format!("{base}-out"))
}

/// 创建一个 named pipe，其 DACL 仅允许 sandbox user 连接。
/// 通过 SDDL 字符串设置安全描述符，确保只有指定的 sandbox user 拥有完全访问权限（GA）。
pub fn create_named_pipe(name: &str, access: u32, sandbox_username: &str) -> io::Result<HANDLE> {
    let sandbox_sid = resolve_sid(sandbox_username)
        .map_err(|err| io::Error::new(io::ErrorKind::PermissionDenied, err.to_string()))?;
    let sandbox_sid = string_from_sid_bytes(&sandbox_sid)
        .map_err(|err| io::Error::new(io::ErrorKind::PermissionDenied, err))?;
    let sddl = to_wide(format!("D:(A;;GA;;;{sandbox_sid})"));
    let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut sd,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let wide = to_wide(name);
    let h = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            access,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            65536,
            65536,
            0,
            &mut sa as *mut SECURITY_ATTRIBUTES,
        )
    };
    unsafe {
        LocalFree(sd as HLOCAL);
    }
    if h == 0 || h == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    Ok(h)
}

/// 等待 runner 连接到由 parent 创建的 server pipe。
///
/// 此函数仅在 parent-side 调用：runner 使用 `CreateFileW` 打开 pipe，而
/// parent 调用 `ConnectNamedPipe`，容忍 already-connected 的情况，并
/// 验证连接的客户端确实是我们刚刚 spawn 的 runner process。
pub fn connect_pipe(h: HANDLE, expected_runner_pid: u32) -> io::Result<()> {
    let ok = unsafe { ConnectNamedPipe(h, ptr::null_mut()) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        const ERROR_PIPE_CONNECTED: u32 = 535;
        if err != ERROR_PIPE_CONNECTED {
            return Err(io::Error::from_raw_os_error(err as i32));
        }
    }
    let mut client_pid = 0;
    let ok = unsafe { GetNamedPipeClientProcessId(h, &mut client_pid) };
    if ok == 0 {
        return Err(io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    if client_pid != expected_runner_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "named pipe client pid {client_pid} did not match runner pid {expected_runner_pid}"
            ),
        ));
    }
    Ok(())
}
