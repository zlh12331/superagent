//! 安装上下文检测模块。
//!
//! 本 crate 通过检测当前可执行文件路径与环境变量，判断 Codex 的安装方式
//!（standalone、npm、bun、brew 或其他），并解析捆绑资源的布局。
//! 核心类型：
//! - [`InstallContext`]：安装上下文，包含安装方式与包布局
//! - [`InstallMethod`]：安装方式枚举
//! - [`CodexPackageLayout`]：Codex 包的目录布局

use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;

use codex_utils_absolute_path::AbsolutePathBuf;

const BIN_DIRNAME: &str = "bin";
const PACKAGE_METADATA_FILENAME: &str = "codex-package.json";
const PATH_DIRNAME: &str = "codex-path";
const RELEASES_DIRNAME: &str = "releases";
const RESOURCES_DIRNAME: &str = "codex-resources";
const STANDALONE_PACKAGES_DIRNAME: &str = "standalone";
const ZSH_DIRNAME: &str = "zsh";
static INSTALL_CONTEXT: OnceLock<InstallContext> = OnceLock::new();

/// Standalone 安装的目标平台。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StandalonePlatform {
    /// Unix 平台（Linux/macOS）。
    Unix,
    /// Windows 平台。
    Windows,
}

/// Codex 包的目录布局。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexPackageLayout {
    /// 包根目录，包含元数据文件与布局子目录。
    pub package_dir: AbsolutePathBuf,
    /// 包含 Codex 入口可执行文件的目录。
    pub bin_dir: AbsolutePathBuf,
    /// 包含受管辅助二进制文件与数据文件的目录（存在时）。
    pub resources_dir: Option<AbsolutePathBuf>,
    /// 应被添加到 PATH 前面的目录（存在时）。
    pub path_dir: Option<AbsolutePathBuf>,
}

/// 安装上下文，记录 Codex 的安装方式与包布局。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallContext {
    /// 安装方式。
    pub method: InstallMethod,
    /// 包布局（存在时）。
    pub package_layout: Option<CodexPackageLayout>,
}

/// Codex 的安装方式。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallMethod {
    /// Standalone 安装。
    Standalone {
        /// 受管 standalone 发布目录。旧版安装使用形如
        /// `~/.codex/packages/standalone/releases/0.111.0-x86_64-unknown-linux-musl`
        /// 的路径。包布局安装使用包含 `bin/`、`codex-resources/` 和
        /// `codex-path/` 的包根目录。
        release_dir: AbsolutePathBuf,
        /// 受管依赖的捆绑资源目录。
        resources_dir: Option<AbsolutePathBuf>,
        /// standalone 发布的平台，`Unix` 或 `Windows`。
        platform: StandalonePlatform,
    },
    /// 通过 npm 管理的 `codex.js` shim 启动的 Codex 二进制。
    Npm,
    /// 通过 bun 管理的 `codex.js` shim 启动的 Codex 二进制。
    Bun,
    /// 来自 Homebrew 安装前缀的 Codex 二进制。
    Brew,
    /// 其他执行环境。
    ///
    /// 通常涵盖 `cargo run`、应用内捆绑的 Codex 二进制、
    /// 自定义内部启动器，以及从任意路径执行 Codex 的测试。
    Other,
}

impl InstallContext {
    /// 从可执行文件路径与环境标志推断安装上下文。
    ///
    /// - `is_macos`：是否运行在 macOS 上（用于 Homebrew 前缀检测）。
    /// - `current_exe`：当前可执行文件路径（通常来自 `std::env::current_exe`）。
    /// - `managed_by_npm`：是否由 npm 管理（`CODEX_MANAGED_BY_NPM` 环境变量）。
    /// - `managed_by_bun`：是否由 bun 管理（`CODEX_MANAGED_BY_BUN` 环境变量）。
    pub fn from_exe(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
    ) -> Self {
        let codex_home = codex_utils_home_dir::find_codex_home().ok();
        Self::from_exe_with_codex_home(
            is_macos,
            current_exe,
            managed_by_npm,
            managed_by_bun,
            codex_home.as_deref(),
        )
    }

    fn from_exe_with_codex_home(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
        codex_home: Option<&Path>,
    ) -> Self {
        let package_layout = current_exe.and_then(CodexPackageLayout::from_exe);
        let method = if managed_by_npm {
            InstallMethod::Npm
        } else if managed_by_bun {
            InstallMethod::Bun
        } else if let Some(exe_path) = current_exe {
            install_method_from_exe(exe_path, codex_home, package_layout.as_ref(), is_macos)
        } else {
            InstallMethod::Other
        };

        Self {
            method,
            package_layout,
        }
    }

    /// 返回全局安装上下文（首次调用时初始化，后续返回同一引用）。
    pub fn current() -> &'static Self {
        INSTALL_CONTEXT.get_or_init(|| {
            let current_exe = std::env::current_exe().ok();
            let managed_by_npm = std::env::var_os("CODEX_MANAGED_BY_NPM").is_some();
            let managed_by_bun = std::env::var_os("CODEX_MANAGED_BY_BUN").is_some();
            Self::from_exe(
                cfg!(target_os = "macos"),
                current_exe.as_deref(),
                managed_by_npm,
                managed_by_bun,
            )
        })
    }

    /// 返回 `rg`（ripgrep）命令路径，优先使用捆绑的 rg。
    pub fn rg_command(&self) -> PathBuf {
        if let Some(package_layout) = &self.package_layout
            && let Some(path_dir) = &package_layout.path_dir
        {
            let bundled_rg = path_dir.join(default_rg_command());
            if bundled_rg.is_file() {
                return bundled_rg.into_path_buf();
            }
        }

        if let InstallMethod::Standalone {
            resources_dir: Some(resources_dir),
            ..
        } = &self.method
        {
            let bundled_rg = resources_dir.join(default_rg_command());
            if bundled_rg.is_file() {
                return bundled_rg.into_path_buf();
            }
        }

        default_rg_command()
    }

    /// 查找捆绑资源文件，返回其绝对路径（存在时）。
    ///
    /// 依次检查包布局的 `resources_dir` 和 standalone 安装的 `resources_dir`。
    pub fn bundled_resource(&self, file_name: impl AsRef<Path>) -> Option<AbsolutePathBuf> {
        if let Some(package_layout) = &self.package_layout
            && let Some(resources_dir) = &package_layout.resources_dir
        {
            let resource = resources_dir.join(file_name.as_ref());
            if resource.is_file() {
                return Some(resource);
            }
        }

        if let InstallMethod::Standalone {
            resources_dir: Some(resources_dir),
            ..
        } = &self.method
        {
            let resource = resources_dir.join(file_name);
            if resource.is_file() {
                return Some(resource);
            }
        }

        None
    }

    /// 返回捆绑的 zsh 可执行文件路径（存在且非 Windows 时）。
    pub fn bundled_zsh_path(&self) -> Option<AbsolutePathBuf> {
        if cfg!(windows) {
            None
        } else {
            self.bundled_resource(zsh_resource_path())
        }
    }

    /// 返回捆绑的 zsh `bin` 目录路径（即 `bundled_zsh_path` 的父目录）。
    pub fn bundled_zsh_bin_dir(&self) -> Option<AbsolutePathBuf> {
        self.bundled_zsh_path()?.parent()
    }
}

impl CodexPackageLayout {
    fn from_exe(exe_path: &Path) -> Option<Self> {
        let canonical_exe = canonical_absolute_path(exe_path)?;
        let exe_dir = canonical_exe.parent()?;
        match exe_dir.file_name() {
            Some(name) if name == OsStr::new(BIN_DIRNAME) => Self::from_package_bin_dir(exe_dir),
            Some(_) | None => None,
        }
    }

    fn from_package_bin_dir(bin_dir: AbsolutePathBuf) -> Option<Self> {
        let package_dir = bin_dir.parent()?;
        if !package_dir.join(PACKAGE_METADATA_FILENAME).is_file() {
            return None;
        }

        Some(Self {
            resources_dir: existing_dir(package_dir.join(RESOURCES_DIRNAME)),
            path_dir: existing_dir(package_dir.join(PATH_DIRNAME)),
            package_dir,
            bin_dir,
        })
    }
}

fn install_method_from_exe(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
    is_macos: bool,
) -> InstallMethod {
    if let Some(standalone_method) = standalone_install_method(exe_path, codex_home, package_layout)
    {
        return standalone_method;
    }

    if is_macos && (exe_path.starts_with("/opt/homebrew") || exe_path.starts_with("/usr/local")) {
        InstallMethod::Brew
    } else {
        InstallMethod::Other
    }
}

fn standalone_install_method(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
) -> Option<InstallMethod> {
    let canonical_codex_home = canonical_absolute_path(codex_home?)?;
    let release_dir = if let Some(package_layout) = package_layout {
        package_layout.package_dir.clone()
    } else {
        canonical_absolute_path(exe_path)?.parent()?
    };
    let releases_root = canonical_codex_home
        .join("packages")
        .join(STANDALONE_PACKAGES_DIRNAME)
        .join(RELEASES_DIRNAME);
    if !release_dir.starts_with(releases_root.as_path()) {
        return None;
    }

    let resources_dir = release_dir.join(RESOURCES_DIRNAME);
    Some(InstallMethod::Standalone {
        release_dir,
        resources_dir: resources_dir.is_dir().then_some(resources_dir),
        platform: standalone_platform(),
    })
}

fn canonical_absolute_path(path: &Path) -> Option<AbsolutePathBuf> {
    let canonical_path = std::fs::canonicalize(path).ok()?;
    AbsolutePathBuf::from_absolute_path(canonical_path).ok()
}

fn standalone_platform() -> StandalonePlatform {
    if cfg!(windows) {
        StandalonePlatform::Windows
    } else {
        StandalonePlatform::Unix
    }
}

fn existing_dir(path: AbsolutePathBuf) -> Option<AbsolutePathBuf> {
    path.is_dir().then_some(path)
}

fn default_rg_command() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("rg.exe")
    } else {
        PathBuf::from("rg")
    }
}

fn zsh_resource_path() -> PathBuf {
    PathBuf::from(ZSH_DIRNAME).join(BIN_DIRNAME).join("zsh")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;

    const TEST_RESOURCE_NAME: &str = "codex-test-helper";

    #[test]
    fn detects_standalone_install_from_release_layout() -> std::io::Result<()> {
        let codex_home = tempfile::tempdir()?;
        let release_dir = codex_home
            .path()
            .join("packages/standalone/releases/1.2.3-x86_64-unknown-linux-musl");
        let resources_dir = release_dir.join(RESOURCES_DIRNAME);
        fs::create_dir_all(&resources_dir)?;
        let exe_path = release_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;
        fs::write(resources_dir.join(default_rg_command()), "")?;
        fs::write(resources_dir.join(TEST_RESOURCE_NAME), "")?;
        let canonical_release_dir =
            AbsolutePathBuf::from_absolute_path(release_dir.canonicalize()?)?;
        let canonical_resources_dir =
            AbsolutePathBuf::from_absolute_path(resources_dir.canonicalize()?)?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ Some(codex_home.path()),
        );
        assert_eq!(
            context,
            InstallContext {
                method: InstallMethod::Standalone {
                    release_dir: canonical_release_dir,
                    resources_dir: Some(canonical_resources_dir.clone()),
                    platform: standalone_platform(),
                },
                package_layout: None,
            }
        );
        assert_eq!(
            context.bundled_resource(TEST_RESOURCE_NAME),
            Some(canonical_resources_dir.join(TEST_RESOURCE_NAME))
        );
        Ok(())
    }

    #[test]
    fn standalone_rg_falls_back_when_resources_are_missing() -> std::io::Result<()> {
        let codex_home = tempfile::tempdir()?;
        let release_dir = codex_home
            .path()
            .join("packages/standalone/releases/1.2.3-x86_64-unknown-linux-musl");
        fs::create_dir_all(&release_dir)?;
        let exe_path = release_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ Some(codex_home.path()),
        );
        assert_eq!(context.rg_command(), default_rg_command());
        Ok(())
    }

    #[test]
    fn detects_package_layout_independently_from_install_method() -> std::io::Result<()> {
        let package_dir = tempfile::tempdir()?;
        let bin_dir = package_dir.path().join(BIN_DIRNAME);
        let resources_dir = package_dir.path().join(RESOURCES_DIRNAME);
        let path_dir = package_dir.path().join(PATH_DIRNAME);
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(&resources_dir)?;
        fs::create_dir_all(&path_dir)?;
        fs::write(package_dir.path().join(PACKAGE_METADATA_FILENAME), "{}")?;
        let exe_path = bin_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;
        fs::write(resources_dir.join(TEST_RESOURCE_NAME), "")?;
        fs::write(path_dir.join(default_rg_command()), "")?;
        if !cfg!(windows) {
            let zsh_path = resources_dir.join(zsh_resource_path());
            fs::create_dir_all(zsh_path.parent().expect("zsh path should have parent"))?;
            fs::write(&zsh_path, "")?;
        }
        let canonical_package_dir =
            AbsolutePathBuf::from_absolute_path(package_dir.path().canonicalize()?)?;
        let canonical_bin_dir = AbsolutePathBuf::from_absolute_path(bin_dir.canonicalize()?)?;
        let canonical_resources_dir =
            AbsolutePathBuf::from_absolute_path(resources_dir.canonicalize()?)?;
        let canonical_path_dir = AbsolutePathBuf::from_absolute_path(path_dir.canonicalize()?)?;
        let package_layout = CodexPackageLayout {
            package_dir: canonical_package_dir,
            bin_dir: canonical_bin_dir,
            resources_dir: Some(canonical_resources_dir.clone()),
            path_dir: Some(canonical_path_dir.clone()),
        };

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(
            context,
            InstallContext {
                method: InstallMethod::Other,
                package_layout: Some(package_layout),
            }
        );
        assert_eq!(
            context.rg_command(),
            canonical_path_dir
                .join(default_rg_command())
                .into_path_buf()
        );
        assert_eq!(
            context.bundled_resource(TEST_RESOURCE_NAME),
            Some(canonical_resources_dir.join(TEST_RESOURCE_NAME))
        );
        if cfg!(windows) {
            assert_eq!(context.bundled_zsh_path(), None);
            assert_eq!(context.bundled_zsh_bin_dir(), None);
        } else {
            assert_eq!(
                context.bundled_zsh_path(),
                Some(canonical_resources_dir.join(zsh_resource_path()))
            );
            assert_eq!(
                context.bundled_zsh_bin_dir(),
                Some(canonical_resources_dir.join(ZSH_DIRNAME).join(BIN_DIRNAME))
            );
        }
        Ok(())
    }

    #[test]
    fn standalone_package_layout_keeps_standalone_install_method() -> std::io::Result<()> {
        let codex_home = tempfile::tempdir()?;
        let package_dir = codex_home
            .path()
            .join("packages/standalone/releases/1.2.3-x86_64-unknown-linux-musl");
        let bin_dir = package_dir.join(BIN_DIRNAME);
        let resources_dir = package_dir.join(RESOURCES_DIRNAME);
        let path_dir = package_dir.join(PATH_DIRNAME);
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(&resources_dir)?;
        fs::create_dir_all(&path_dir)?;
        fs::write(package_dir.join(PACKAGE_METADATA_FILENAME), "{}")?;
        let exe_path = bin_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;
        fs::write(resources_dir.join(TEST_RESOURCE_NAME), "")?;
        fs::write(path_dir.join(default_rg_command()), "")?;
        let canonical_package_dir =
            AbsolutePathBuf::from_absolute_path(package_dir.canonicalize()?)?;
        let canonical_bin_dir = AbsolutePathBuf::from_absolute_path(bin_dir.canonicalize()?)?;
        let canonical_resources_dir =
            AbsolutePathBuf::from_absolute_path(resources_dir.canonicalize()?)?;
        let canonical_path_dir = AbsolutePathBuf::from_absolute_path(path_dir.canonicalize()?)?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ Some(codex_home.path()),
        );
        assert_eq!(
            context,
            InstallContext {
                method: InstallMethod::Standalone {
                    release_dir: canonical_package_dir.clone(),
                    resources_dir: Some(canonical_resources_dir.clone()),
                    platform: standalone_platform(),
                },
                package_layout: Some(CodexPackageLayout {
                    package_dir: canonical_package_dir,
                    bin_dir: canonical_bin_dir,
                    resources_dir: Some(canonical_resources_dir.clone()),
                    path_dir: Some(canonical_path_dir.clone()),
                }),
            }
        );
        assert_eq!(
            context.rg_command(),
            canonical_path_dir
                .join(default_rg_command())
                .into_path_buf()
        );
        assert_eq!(
            context.bundled_resource(TEST_RESOURCE_NAME),
            Some(canonical_resources_dir.join(TEST_RESOURCE_NAME))
        );
        Ok(())
    }

    #[test]
    fn npm_managed_package_keeps_package_layout() -> std::io::Result<()> {
        let package_dir = tempfile::tempdir()?;
        let bin_dir = package_dir.path().join(BIN_DIRNAME);
        let path_dir = package_dir.path().join(PATH_DIRNAME);
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(&path_dir)?;
        fs::write(package_dir.path().join(PACKAGE_METADATA_FILENAME), "{}")?;
        let exe_path = bin_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;
        fs::write(path_dir.join(default_rg_command()), "")?;
        let canonical_path_dir = AbsolutePathBuf::from_absolute_path(path_dir.canonicalize()?)?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ true,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(context.method, InstallMethod::Npm);
        assert!(context.package_layout.is_some());
        assert_eq!(
            context.rg_command(),
            canonical_path_dir
                .join(default_rg_command())
                .into_path_buf()
        );
        Ok(())
    }

    #[test]
    fn standalone_package_rg_falls_back_when_codex_path_is_missing() -> std::io::Result<()> {
        let package_dir = tempfile::tempdir()?;
        let bin_dir = package_dir.path().join(BIN_DIRNAME);
        fs::create_dir_all(&bin_dir)?;
        fs::write(package_dir.path().join(PACKAGE_METADATA_FILENAME), "{}")?;
        let exe_path = bin_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(context.rg_command(), default_rg_command());
        Ok(())
    }

    #[test]
    fn bundled_file_lookups_ignore_directories() -> std::io::Result<()> {
        let package_dir = tempfile::tempdir()?;
        let bin_dir = package_dir.path().join(BIN_DIRNAME);
        let resources_dir = package_dir.path().join(RESOURCES_DIRNAME);
        let path_dir = package_dir.path().join(PATH_DIRNAME);
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(resources_dir.join(TEST_RESOURCE_NAME))?;
        fs::create_dir_all(path_dir.join(default_rg_command()))?;
        fs::write(package_dir.path().join(PACKAGE_METADATA_FILENAME), "{}")?;
        let exe_path = bin_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        fs::write(&exe_path, "")?;

        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(&exe_path),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(context.rg_command(), default_rg_command());
        assert_eq!(context.bundled_resource(TEST_RESOURCE_NAME), None);
        Ok(())
    }

    #[test]
    fn npm_and_bun_take_precedence() {
        let npm_context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(Path::new("/tmp/codex")),
            /*managed_by_npm*/ true,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(
            npm_context,
            InstallContext {
                method: InstallMethod::Npm,
                package_layout: None,
            }
        );

        let bun_context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ false,
            /*current_exe*/ Some(Path::new("/tmp/codex")),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ true,
            /*codex_home*/ None,
        );
        assert_eq!(
            bun_context,
            InstallContext {
                method: InstallMethod::Bun,
                package_layout: None,
            }
        );
    }

    #[test]
    fn brew_is_detected_on_macos_prefixes() {
        let context = InstallContext::from_exe_with_codex_home(
            /*is_macos*/ true,
            /*current_exe*/ Some(Path::new("/opt/homebrew/bin/codex")),
            /*managed_by_npm*/ false,
            /*managed_by_bun*/ false,
            /*codex_home*/ None,
        );
        assert_eq!(
            context,
            InstallContext {
                method: InstallMethod::Brew,
                package_layout: None,
            }
        );
    }
}
