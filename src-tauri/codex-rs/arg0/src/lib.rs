//! "arg0 trick" 模块：根据启动时 argv[0] 的名字，把单个 Codex 可执行文件
//! 分发到不同的子命令入口（如 `apply_patch`、`codex-linux-sandbox` 等）。
//!
//! 同时负责在启动早期：
//! - 加载 `~/.codex/.env`；
//! - 在 PATH 中创建临时目录并放入指向当前可执行文件的别名（symlink / .bat）；
//! - 在主线程上以指定的栈大小启动 Tokio runtime 并执行调用方的 async main。

use std::ffi::OsString;
use std::fs::File;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;

use codex_apply_patch::CODEX_CORE_APPLY_PATCH_ARG1;
use codex_exec_server::CODEX_FS_HELPER_ARG1;
use codex_install_context::InstallContext;
use codex_sandboxing::landlock::CODEX_LINUX_SANDBOX_ARG0;
use codex_utils_home_dir::find_codex_home;
#[cfg(target_os = "windows")]
use codex_windows_sandbox::CODEX_WINDOWS_SANDBOX_ARG1;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use tempfile::TempDir;

/// argv[0] 名字为 `apply_patch` 时的入口别名。
const APPLY_PATCH_ARG0: &str = "apply_patch";
/// 兼容用户手误写成 `applypatch`（无下划线）的别名。
const MISSPELLED_APPLY_PATCH_ARG0: &str = "applypatch";
#[cfg(unix)]
/// execve 包装器的 argv[0] 别名（仅 UNIX）。
const EXECVE_WRAPPER_ARG0: &str = "codex-execve-wrapper";
/// 用于按会话锁定临时目录的锁文件名。
const LOCK_FILENAME: &str = ".lock";
/// Tokio worker 线程栈大小（16 MiB）。
const TOKIO_WORKER_STACK_SIZE_BYTES: usize = 16 * 1024 * 1024;

/// 保存 arg0 派生出的可执行文件路径集合。
///
/// 这些路径供子进程在 re-exec 时使用，避免依赖 `current_exe()`。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Arg0DispatchPaths {
    /// 当前 Codex 可执行文件的稳定路径，用于子进程 re-exec。
    ///
    /// 在测试 harness 下应优先使用此字段而非 [`std::env::current_exe()`]，
    /// 因为后者可能指向 harness 而非真正的 Codex CLI。
    pub codex_self_exe: Option<PathBuf>,
    /// `codex-linux-sandbox` 别名路径（仅 Linux）。
    pub codex_linux_sandbox_exe: Option<PathBuf>,
    /// `codex-execve-wrapper` 别名路径（仅 UNIX）。
    pub main_execve_wrapper_exe: Option<PathBuf>,
}

/// 在进程生命周期内保持按会话创建的 PATH 临时目录及其锁文件不被释放。
pub struct Arg0PathEntryGuard {
    _temp_dir: TempDir,
    _lock_file: File,
    paths: Arg0DispatchPaths,
}

impl Arg0PathEntryGuard {
    fn new(temp_dir: TempDir, lock_file: File, paths: Arg0DispatchPaths) -> Self {
        Self {
            _temp_dir: temp_dir,
            _lock_file: lock_file,
            paths,
        }
    }

    /// 返回该 guard 持有的派生路径集合。
    pub fn paths(&self) -> &Arg0DispatchPaths {
        &self.paths
    }
}

/// 执行 arg0 派发：根据 argv[0] / argv[1] 进入对应的子命令入口，
/// 同时为后续主流程准备 PATH 临时目录与 guard。
///
/// 返回的 guard 应在主流程结束前一直保持存活，以保证别名文件存在。
pub fn arg0_dispatch() -> Option<Arg0PathEntryGuard> {
    // 判断是否通过特殊别名启动。
    let mut args = std::env::args_os();
    let argv0 = args.next().unwrap_or_default();
    let exe_name = Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    #[cfg(unix)]
    if exe_name == EXECVE_WRAPPER_ARG0 {
        let mut args = std::env::args();
        let _ = args.next();
        let file = match args.next() {
            Some(file) => file,
            None => std::process::exit(1),
        };
        let argv = args.collect::<Vec<_>>();

        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => std::process::exit(1),
        };
        let exit_code = runtime.block_on(
            codex_shell_escalation::run_shell_escalation_execve_wrapper(file, argv),
        );
        match exit_code {
            Ok(exit_code) => std::process::exit(exit_code),
            Err(_) => std::process::exit(1),
        }
    }

    if exe_name == CODEX_LINUX_SANDBOX_ARG0 {
        // 安全性：[`run_main`] 永不返回。
        codex_linux_sandbox::run_main();
    } else if exe_name == APPLY_PATCH_ARG0 || exe_name == MISSPELLED_APPLY_PATCH_ARG0 {
        codex_apply_patch::main();
    }

    let argv1 = args.next().unwrap_or_default();
    if argv1 == CODEX_FS_HELPER_ARG1 {
        codex_exec_server::run_fs_helper_main();
    }
    #[cfg(target_os = "windows")]
    if argv1 == CODEX_WINDOWS_SANDBOX_ARG1 {
        codex_windows_sandbox::run_windows_sandbox_wrapper_main();
    }
    if argv1 == CODEX_CORE_APPLY_PATCH_ARG1 {
        let patch_arg = args.next().and_then(|s| s.to_str().map(str::to_owned));
        let exit_code = match patch_arg {
            Some(patch_arg) => {
                let mut stdout = std::io::stdout();
                let mut stderr = std::io::stderr();
                let cwd = match codex_utils_absolute_path::AbsolutePathBuf::current_dir() {
                    Ok(cwd) => cwd,
                    Err(_) => std::process::exit(1),
                };
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => std::process::exit(1),
                };
                let cwd = cwd.into();
                match runtime.block_on(codex_apply_patch::apply_patch(
                    &patch_arg,
                    &cwd,
                    &mut stdout,
                    &mut stderr,
                    codex_exec_server::LOCAL_FS.as_ref(),
                    /*sandbox*/ None,
                )) {
                    Ok(_) => 0,
                    Err(_) => 1,
                }
            }
            None => {
                eprintln!("Error: {CODEX_CORE_APPLY_PATCH_ARG1} requires a UTF-8 PATCH argument.");
                1
            }
        };
        std::process::exit(exit_code);
    }

    // 修改环境变量不是线程安全的，因此必须在创建任何线程 / Tokio runtime 之前完成。
    load_dotenv();

    let (path_entry_guard, updated_path_env_var) = prepare_path_env_var_with_aliases(
        InstallContext::current(),
        std::env::var_os("PATH"),
        prepare_path_entry_for_codex_aliases,
    );
    if let Some(updated_path_env_var) = updated_path_env_var {
        // 此时进程仍是单线程，调用 set_var() 是安全的。
        unsafe {
            std::env::set_var("PATH", updated_path_env_var);
        }
    }
    path_entry_guard
}

fn prepare_path_env_var_with_aliases(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
    prepare_aliases: impl FnOnce(Option<OsString>) -> std::io::Result<(Arg0PathEntryGuard, OsString)>,
) -> (Option<Arg0PathEntryGuard>, Option<OsString>) {
    let package_path = path_env_with_package_path_dir(install_context, existing_path.clone());
    let path_for_aliases = package_path.clone().or(existing_path);

    match prepare_aliases(path_for_aliases) {
        Ok((path_entry, updated_path_env_var)) => (Some(path_entry), Some(updated_path_env_var)),
        Err(err) => {
            // 即使创建别名失败，Codex 仍可能继续工作，因此只警告并继续。
            eprintln!("WARNING: proceeding, even though we could not create PATH aliases: {err}");
            (None, package_path)
        }
    }
}

/// 我们希望把 Codex CLI 部署为单一可执行文件以简化使用，
/// 同时也希望以独立 CLI 的形式暴露其中部分功能。这里使用 "arg0 trick"
/// 来决定派发到哪个 CLI：通过 argv[0] 的文件名判断。这样可以在 Mac / Linux
/// 上将"多可执行文件"模拟为"单可执行文件"（Windows 上不适用）。
///
/// 当通过名为 `codex-linux-sandbox` 的硬链接 / 别名启动时，我们 *直接*
/// 调用 [`codex_linux_sandbox::run_main`]（永不返回）。否则：
///
/// 1. 在创建任何线程前加载 `~/.codex/.env`。
/// 2. 在指定栈大小的工作线程上启动主 runtime。
/// 3. 构造 Tokio 多线程 runtime。
/// 4. 捕获当前可执行文件路径，并派生出 `codex-linux-sandbox` helper 路径
///    （失败时回退为当前可执行文件路径），以便在 Linux 上子进程可以
///    re-exec 沙箱。
/// 5. 在该 runtime 中执行传入的 async `main_fn`，并向上传播错误。
///    `main_fn` 会收到 [`Arg0DispatchPaths`]，其中包含构造
///    [`codex_core::config::Config`] 所需的 helper 可执行文件路径。
///
/// 本函数应被本 workspace 中所有依赖这些 helper CLI 的 bin crate 的
/// `main()` 函数包裹使用。
pub fn arg0_dispatch_or_else<F, Fut>(main_fn: F) -> anyhow::Result<()>
where
    F: FnOnce(Arg0DispatchPaths) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>>,
{
    // 保留 TempDir 不被释放，使其在本可执行文件运行期间一直存在。
    // 虽然可以调用 `keep()` 让它永久保留，但能不留下临时目录更好。
    let path_entry_guard = arg0_dispatch();
    let current_exe = std::env::current_exe().ok();

    // 常规调用：在与 Tokio worker 相同栈大小的工作线程上运行 async 入口；
    // 否则 `Runtime::block_on` 会在调用方的 OS 栈上运行顶层 future。
    let handle = std::thread::Builder::new()
        .name("codex-main".to_string())
        .stack_size(TOKIO_WORKER_STACK_SIZE_BYTES)
        .spawn(move || {
            let runtime = build_runtime()?;
            runtime.block_on(run_main_with_arg0_guard(
                path_entry_guard,
                current_exe,
                main_fn,
            ))
        })?;
    match handle.join() {
        Ok(result) => result,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

async fn run_main_with_arg0_guard<F, Fut>(
    path_entry_guard: Option<Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
    main_fn: F,
) -> anyhow::Result<()>
where
    F: FnOnce(Arg0DispatchPaths) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let paths = Arg0DispatchPaths {
        codex_self_exe: current_exe.clone(),
        codex_linux_sandbox_exe: if cfg!(target_os = "linux") {
            linux_sandbox_exe_path(path_entry_guard.as_ref(), current_exe)
        } else {
            None
        },
        main_execve_wrapper_exe: path_entry_guard
            .as_ref()
            .and_then(|path_entry| path_entry.paths().main_execve_wrapper_exe.clone()),
    };

    let result = main_fn(paths).await;
    // 让 arg0 临时目录 guard 一直活到 async 入口结束；
    // 因为 runtime 路径可能指向该目录内的别名。
    drop(path_entry_guard);
    result
}

fn linux_sandbox_exe_path(
    path_entry_guard: Option<&Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
) -> Option<PathBuf> {
    // 优先使用 `codex-linux-sandbox` 别名路径，这样调用方 re-exec 时
    // 仍能通过 basename 触发 arg0 派发（针对不支持 `--argv0` 的 bubblewrap 构建）。
    path_entry_guard
        .and_then(|path_entry| path_entry.paths().codex_linux_sandbox_exe.clone())
        .or(current_exe)
}

fn build_runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    builder.thread_stack_size(TOKIO_WORKER_STACK_SIZE_BYTES);
    Ok(builder.build()?)
}

/// 禁止 `.env` 中以 `CODEX_` 为前缀的变量（安全限制）。
const ILLEGAL_ENV_VAR_PREFIX: &str = "CODEX_";

/// 从 `~/.codex/.env` 加载环境变量。
///
/// 安全性：禁止 `.env` 创建或修改任何以 `CODEX_` 开头的变量名。
fn load_dotenv() {
    if let Ok(codex_home) = find_codex_home()
        && let Ok(iter) = dotenvy::from_path_iter(codex_home.join(".env"))
    {
        set_filtered(iter);
    }
}

/// 从 dotenvy 迭代器中设置变量，过滤掉 `CODEX_` 前缀的 key。
fn set_filtered<I>(iter: I)
where
    I: IntoIterator<Item = Result<(String, String), dotenvy::Error>>,
{
    for (key, value) in iter.into_iter().flatten() {
        if !key.to_ascii_uppercase().starts_with(ILLEGAL_ENV_VAR_PREFIX) {
            // 此时进程仍是单线程，调用 set_var() 是安全的。
            unsafe { std::env::set_var(&key, &value) };
        }
    }
}

/// 创建一个临时目录，其中包含：
///
/// - UNIX：指向当前可执行文件的 `apply_patch` 符号链接。
/// - Windows：调用当前可执行文件并附上隐藏 `--codex-run-as-apply-patch` 标记的
///   `apply_patch.bat` 批处理脚本。
///
/// 返回临时目录 guard 以及在原 PATH 前追加该临时目录后的新 PATH 值。
/// 这样无需安装独立可执行文件即可让 `apply_patch` 出现在 PATH 上，
/// 简化 Codex CLI 的部署。
/// 注意：debug 构建下临时目录 guard 会禁用一些检查，便于本地测试。
///
/// 重要：调用方必须在创建任何线程之前更新 PATH。
fn prepare_path_entry_for_codex_aliases(
    existing_path: Option<OsString>,
) -> std::io::Result<(Arg0PathEntryGuard, OsString)> {
    let codex_home = find_codex_home()?;
    #[cfg(not(debug_assertions))]
    {
        // 非 debug 构建下：禁止把 helper 放在系统临时目录下。
        let temp_root = std::env::temp_dir();
        if codex_home.starts_with(&temp_root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "Refusing to create helper binaries under temporary dir {temp_root:?} (codex_home: {codex_home:?})"
                ),
            ));
        }
    }

    std::fs::create_dir_all(&codex_home)?;
    // 使用 CODEX_HOME 范围内的临时根目录，避免污染顶层目录。
    let temp_root = codex_home.join("tmp").join("arg0");
    std::fs::create_dir_all(&temp_root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        // 确保只有当前用户能访问该临时目录。
        std::fs::set_permissions(&temp_root, std::fs::Permissions::from_mode(0o700))?;
    }

    // 尽力清理过期会话目录；失败仅警告，不影响启动。
    if let Err(err) = janitor_cleanup(&temp_root) {
        eprintln!("WARNING: failed to clean up stale arg0 temp dirs: {err}");
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("codex-arg0")
        .tempdir_in(&temp_root)?;
    let path = temp_dir.path();

    let lock_path = path.join(LOCK_FILENAME);
    let lock_file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock_file.try_lock()?;

    for filename in &[
        APPLY_PATCH_ARG0,
        MISSPELLED_APPLY_PATCH_ARG0,
        #[cfg(target_os = "linux")]
        CODEX_LINUX_SANDBOX_ARG0,
        #[cfg(unix)]
        EXECVE_WRAPPER_ARG0,
    ] {
        let exe = std::env::current_exe()?;

        #[cfg(unix)]
        {
            let link = path.join(filename);
            symlink(&exe, &link)?;
        }

        #[cfg(windows)]
        {
            let batch_script = path.join(format!("{filename}.bat"));
            let exe = exe.display();
            std::fs::write(
                &batch_script,
                format!(
                    r#"@echo off
"{exe}" {CODEX_CORE_APPLY_PATCH_ARG1} %*
"#,
                ),
            )?;
        }
    }

    let updated_path_env_var = path_env_with_entry(path, existing_path);

    let paths = Arg0DispatchPaths {
        codex_self_exe: std::env::current_exe().ok(),
        codex_linux_sandbox_exe: {
            #[cfg(target_os = "linux")]
            {
                Some(path.join(CODEX_LINUX_SANDBOX_ARG0))
            }
            #[cfg(not(target_os = "linux"))]
            {
                None
            }
        },
        main_execve_wrapper_exe: {
            #[cfg(unix)]
            {
                Some(path.join(EXECVE_WRAPPER_ARG0))
            }
            #[cfg(not(unix))]
            {
                None
            }
        },
    };

    Ok((
        Arg0PathEntryGuard::new(temp_dir, lock_file, paths),
        updated_path_env_var,
    ))
}

fn path_env_with_package_path_dir(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
) -> Option<OsString> {
    let path_dir = install_context
        .package_layout
        .as_ref()
        .and_then(|package_layout| package_layout.path_dir.as_ref())?;
    Some(path_env_with_entry(path_dir.as_path(), existing_path))
}

fn path_env_with_entry(path_entry: &Path, existing_path: Option<OsString>) -> OsString {
    #[cfg(unix)]
    const PATH_SEPARATOR: &str = ":";

    #[cfg(windows)]
    const PATH_SEPARATOR: &str = ";";

    let capacity = path_entry.as_os_str().len()
        + existing_path
            .as_ref()
            .map_or(0, |existing_path| 1 + existing_path.len());
    let mut path_env_var = OsString::with_capacity(capacity);
    path_env_var.push(path_entry);
    if let Some(existing_path) = existing_path {
        path_env_var.push(PATH_SEPARATOR);
        path_env_var.push(existing_path);
    }
    path_env_var
}

/// 清理过期会话目录：遍历 `temp_root`，删除未被锁定的子目录。
fn janitor_cleanup(temp_root: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(temp_root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // 加锁失败或锁正被持有时跳过该目录。
        let Some(_lock_file) = try_lock_dir(&path)? else {
            continue;
        };

        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            // 预期的 TOCTOU 竞态：目录可能在 read_dir / lock 检查后消失。
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        }
    }

    Ok(())
}

/// 尝试锁定指定目录下的 `.lock` 文件，成功则返回该文件句柄。
fn try_lock_dir(dir: &Path) -> std::io::Result<Option<File>> {
    let lock_path = dir.join(LOCK_FILENAME);
    let lock_file = match File::options().read(true).write(true).open(&lock_path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };

    match lock_file.try_lock() {
        Ok(()) => Ok(Some(lock_file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::Arg0DispatchPaths;
    use super::Arg0PathEntryGuard;
    use super::LOCK_FILENAME;
    use super::janitor_cleanup;
    use super::linux_sandbox_exe_path;
    #[cfg(unix)]
    use super::run_main_with_arg0_guard;
    #[cfg(unix)]
    use anyhow::ensure;
    use codex_install_context::CodexPackageLayout;
    use codex_install_context::InstallContext;
    use codex_install_context::InstallMethod;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::fs::File;
    use std::path::Path;
    use std::path::PathBuf;
    use tempfile::TempDir;

    struct PackagePathTestFixture {
        _temp_dir: TempDir,
        arg0_dir: PathBuf,
        existing_dir: PathBuf,
        install_context: InstallContext,
        path_dir: AbsolutePathBuf,
    }

    fn create_lock(dir: &Path) -> std::io::Result<File> {
        let lock_path = dir.join(LOCK_FILENAME);
        File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
    }

    fn package_path_test_fixture() -> anyhow::Result<PackagePathTestFixture> {
        let temp_dir = TempDir::new()?;
        let arg0_dir = temp_dir.path().join("arg0");
        let package_dir = temp_dir.path().join("package");
        let bin_dir = package_dir.join("bin");
        let path_dir = package_dir.join("codex-path");
        let existing_dir = temp_dir.path().join("existing-bin");
        fs::create_dir_all(&arg0_dir)?;
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(&path_dir)?;
        fs::create_dir_all(&existing_dir)?;
        let path_dir = AbsolutePathBuf::from_absolute_path(path_dir.canonicalize()?)?;
        let install_context = InstallContext {
            method: InstallMethod::Other,
            package_layout: Some(CodexPackageLayout {
                package_dir: AbsolutePathBuf::from_absolute_path(package_dir.canonicalize()?)?,
                bin_dir: AbsolutePathBuf::from_absolute_path(bin_dir.canonicalize()?)?,
                resources_dir: None,
                path_dir: Some(path_dir.clone()),
            }),
        };

        Ok(PackagePathTestFixture {
            _temp_dir: temp_dir,
            arg0_dir,
            existing_dir,
            install_context,
            path_dir,
        })
    }

    #[test]
    fn linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias() -> std::io::Result<()> {
        let temp_dir = TempDir::new()?;
        let lock_file = create_lock(temp_dir.path())?;
        let alias_path = temp_dir.path().join("codex-linux-sandbox");
        let path_entry = Arg0PathEntryGuard::new(
            temp_dir,
            lock_file,
            Arg0DispatchPaths {
                codex_self_exe: Some(PathBuf::from("/usr/bin/codex")),
                codex_linux_sandbox_exe: Some(alias_path.clone()),
                main_execve_wrapper_exe: None,
            },
        );

        assert_eq!(
            linux_sandbox_exe_path(Some(&path_entry), Some(PathBuf::from("/usr/bin/codex"))),
            Some(alias_path),
        );
        Ok(())
    }

    #[test]
    fn path_env_can_prepend_package_path_before_arg0_alias_dir() -> anyhow::Result<()> {
        let fixture = package_path_test_fixture()?;

        let package_path = super::path_env_with_package_path_dir(
            &fixture.install_context,
            Some(fixture.existing_dir.as_os_str().to_owned()),
        )
        .expect("package path dir should update PATH");
        let updated_path = super::path_env_with_entry(&fixture.arg0_dir, Some(package_path));

        assert_eq!(
            std::env::split_paths(&updated_path).collect::<Vec<_>>(),
            vec![
                fixture.arg0_dir,
                fixture.path_dir.as_path().to_path_buf(),
                fixture.existing_dir
            ],
        );
        Ok(())
    }

    #[test]
    fn package_path_survives_arg0_alias_setup_failure() -> anyhow::Result<()> {
        let fixture = package_path_test_fixture()?;

        let (path_entry_guard, updated_path_env_var) = super::prepare_path_env_var_with_aliases(
            &fixture.install_context,
            Some(fixture.existing_dir.as_os_str().to_owned()),
            |path_for_aliases| {
                assert_eq!(
                    std::env::split_paths(
                        &path_for_aliases.expect("package PATH should be passed to alias setup")
                    )
                    .collect::<Vec<_>>(),
                    vec![
                        fixture.path_dir.as_path().to_path_buf(),
                        fixture.existing_dir.clone()
                    ],
                );
                Err(std::io::Error::other("alias setup failed"))
            },
        );

        assert!(path_entry_guard.is_none());
        let updated_path_env_var =
            updated_path_env_var.expect("package PATH should survive alias setup failure");
        assert_eq!(
            std::env::split_paths(&updated_path_env_var).collect::<Vec<_>>(),
            vec![
                fixture.path_dir.as_path().to_path_buf(),
                fixture.existing_dir
            ],
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns() -> anyhow::Result<()> {
        let temp_dir = TempDir::new()?;
        let alias_path = temp_dir.path().join("codex-helper-alias");
        fs::write(&alias_path, b"")?;
        let lock_file = create_lock(temp_dir.path())?;
        let path_entry = Arg0PathEntryGuard::new(
            temp_dir,
            lock_file,
            Arg0DispatchPaths {
                codex_self_exe: Some(PathBuf::from("/usr/bin/codex")),
                codex_linux_sandbox_exe: Some(alias_path.clone()),
                main_execve_wrapper_exe: Some(alias_path),
            },
        );

        super::build_runtime()?.block_on(run_main_with_arg0_guard(
            /*path_entry_guard*/ Some(path_entry),
            Some(PathBuf::from("/usr/bin/codex")),
            |paths| async move {
                let alias_path = paths
                    .codex_linux_sandbox_exe
                    .or(paths.main_execve_wrapper_exe)
                    .expect("unix dispatch should create at least one alias path");
                ensure!(
                    alias_path.exists(),
                    "alias path disappeared before main future was polled: {}",
                    alias_path.display()
                );

                tokio::task::yield_now().await;

                ensure!(
                    alias_path.exists(),
                    "alias path disappeared while main future was running: {}",
                    alias_path.display()
                );
                Ok(())
            },
        ))
    }

    #[test]
    fn janitor_skips_dirs_without_lock_file() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let dir = root.path().join("no-lock");
        fs::create_dir(&dir)?;

        janitor_cleanup(root.path())?;

        assert!(dir.exists());
        Ok(())
    }

    #[test]
    fn janitor_skips_dirs_with_held_lock() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let dir = root.path().join("locked");
        fs::create_dir(&dir)?;
        let lock_file = create_lock(&dir)?;
        lock_file.try_lock()?;

        janitor_cleanup(root.path())?;

        assert!(dir.exists());
        Ok(())
    }

    #[test]
    fn janitor_removes_dirs_with_unlocked_lock() -> std::io::Result<()> {
        let root = tempfile::tempdir()?;
        let dir = root.path().join("stale");
        fs::create_dir(&dir)?;
        create_lock(&dir)?;

        janitor_cleanup(root.path())?;

        assert!(!dir.exists());
        Ok(())
    }
}
