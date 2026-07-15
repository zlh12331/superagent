//! Codex 出站 HTTP 与 websocket client 的 custom CA 处理。
//!
//! Codex 在多个 crate 中构造出站 reqwest client 与安全 websocket 连接，但当企业
//! proxy 或 gateway 拦截 TLS 时，它们都需要相同的 trust-store 策略。本模块将该策略集中管理，
//! 使调用方可以从普通的 `reqwest::ClientBuilder` 或 rustls client config 出发，叠加 custom CA
//! 支持，最终要么得到一个已配置好的 transport，要么得到一个面向用户的错误，说明如何修复配置错误的
//! CA bundle。
//!
//! 本模块有意将职责收窄为：
//!
//! - 从 `CODEX_CA_CERTIFICATE` 读取 CA material，未设置时回退到 `SSL_CERT_FILE`
//! - 归一化实际部署中常见的 PEM 变体，包括 OpenSSL 风格的 `TRUSTED CERTIFICATE` 标签
//!   以及同时包含 CRL 的 bundle
//! - 返回面向用户的错误，说明如何修复配置错误的 CA 文件
//!
//! 其生产契约同样收窄：要么产生一个 root store 中包含已配置 PEM bundle 中所有可解析 certificate
//! block 的 transport 配置；要么在调用方开始网络通信之前，以一个精确错误提前失败。
//!
//! 在本模块的测试约定中，hermetic test（密闭测试）指结果仅依赖于该测试自己选定的 CA 文件与
//! 环境变量的测试。这一点在这里很重要，因为常规的 reqwest client 构造路径对环境敏感测试而言
//! 并不够密闭：
//!
//! - 在 macOS seatbelt 运行环境下，`reqwest::Client::builder().build()` 在 probe 平台 proxy
//!   设置时可能在 `system-configuration` 内部 panic，这意味着进程可能在 custom-CA 代码上报成功
//!   或结构化错误之前就退出。这在实践中确实会出现：Codex 本身经常在 seatbelt 下运行派生的测试
//!   进程，因此这并非假想的 CI 边界场景。
//! - 子进程默认会继承 CA 相关的环境变量，若测试不主动清除这些变量，开发者 shell 状态或 CI 配置
//!   就可能影响测试结果
//!
//! 因此本 crate 的测试被拆分为两层：
//!
//! - 本模块内的 unit tests 覆盖 env 选择逻辑，不构造真实 client
//! - `tests/` 下的 subprocess 集成测试覆盖真实 client 构造，通过
//!   [`build_reqwest_client_for_subprocess_tests`] 进行，该入口会禁用 reqwest 的 proxy
//!   自动探测，使测试能直接观察 custom-CA 的成功与失败，包括通过本地 HTTPS server 完成的一次
//!   TLS 握手
//! - 这些 subprocess 测试在启动前还会清除继承自父进程的 CA 环境变量，确保结果只取决于测试
//!   fixture 与测试自身设置的 env vars

use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use codex_utils_rustls_provider::ensure_rustls_crypto_provider;
use rustls::ClientConfig;
use rustls::RootCertStore;
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::pem::SectionKind;
use rustls_pki_types::pem::{self};
use thiserror::Error;
use tracing::info;
use tracing::warn;

pub const CODEX_CA_CERT_ENV: &str = "CODEX_CA_CERTIFICATE";
pub const SSL_CERT_FILE_ENV: &str = "SSL_CERT_FILE";
const CA_CERT_HINT: &str = "If you set CODEX_CA_CERTIFICATE or SSL_CERT_FILE, ensure it points to a PEM file containing one or more CERTIFICATE blocks, or unset it to use system roots.";
type PemSection = (SectionKind, Vec<u8>);

/// 描述基于共享 custom CA 支持构造 transport 失败的原因。
///
/// 这些失败模式同时适用于 reqwest client 构造与 websocket TLS 配置。build 失败的
/// 原因可能是：配置的 CA 文件无法读取、无法解析为 certificate、包含目标 TLS 栈拒绝注册的
/// certificate，或最终的 reqwest client builder 失败。不关心这些区别的调用方可依赖
/// `From<BuildCustomCaTransportError> for io::Error` 转换。
#[derive(Debug, Error)]
pub enum BuildCustomCaTransportError {
    /// 在进行任何 PEM 解析之前，从磁盘读取所选 CA 文件失败。
    #[error(
        "Failed to read CA certificate file {} selected by {}: {source}. {hint}",
        path.display(),
        source_env,
        hint = CA_CERT_HINT
    )]
    ReadCaFile {
        source_env: &'static str,
        path: PathBuf,
        source: io::Error,
    },

    /// 所选 CA 文件可读，但未能产出可用的 certificate material。
    #[error(
        "Failed to load CA certificates from {} selected by {}: {detail}. {hint}",
        path.display(),
        source_env,
        hint = CA_CERT_HINT
    )]
    InvalidCaFile {
        source_env: &'static str,
        path: PathBuf,
        detail: String,
    },

    /// 某个已解析的 certificate block 无法注册到 reqwest client builder。
    #[error(
        "Failed to parse certificate #{certificate_index} from {} selected by {}: {source}. {hint}",
        path.display(),
        source_env,
        hint = CA_CERT_HINT
    )]
    RegisterCertificate {
        source_env: &'static str,
        path: PathBuf,
        certificate_index: usize,
        source: reqwest::Error,
    },

    /// 加载 custom CA bundle 后，reqwest 拒绝了最终的 client 配置。
    #[error(
        "Failed to build HTTP client while using CA bundle from {} ({}): {source}",
        source_env,
        path.display()
    )]
    BuildClientWithCustomCa {
        source_env: &'static str,
        path: PathBuf,
        #[source]
        source: reqwest::Error,
    },

    /// 仅使用系统 roots 时，reqwest 拒绝了最终的 client 配置。
    #[error("Failed to build HTTP client while using system root certificates: {0}")]
    BuildClientWithSystemRoots(#[source] reqwest::Error),

    /// 某个已解析的 certificate block 无法注册到 websocket TLS root store。
    #[error(
        "Failed to register certificate #{certificate_index} from {} selected by {} in rustls root store: {source}. {hint}",
        path.display(),
        source_env,
        hint = CA_CERT_HINT
    )]
    RegisterRustlsCertificate {
        source_env: &'static str,
        path: PathBuf,
        certificate_index: usize,
        source: rustls::Error,
    },
}

impl From<BuildCustomCaTransportError> for io::Error {
    fn from(error: BuildCustomCaTransportError) -> Self {
        match error {
            BuildCustomCaTransportError::ReadCaFile { ref source, .. } => {
                io::Error::new(source.kind(), error)
            }
            BuildCustomCaTransportError::InvalidCaFile { .. }
            | BuildCustomCaTransportError::RegisterCertificate { .. }
            | BuildCustomCaTransportError::RegisterRustlsCertificate { .. } => {
                io::Error::new(io::ErrorKind::InvalidData, error)
            }
            BuildCustomCaTransportError::BuildClientWithCustomCa { .. }
            | BuildCustomCaTransportError::BuildClientWithSystemRoots(_) => io::Error::other(error),
        }
    }
}

/// 构造一个遵循 Codex custom CA 环境变量的 reqwest client。
///
/// 调用方提供所需的 baseline builder 配置，本 helper 在最终构造 client 之前叠加 custom CA
/// 处理。`CODEX_CA_CERTIFICATE` 优先级高于 `SSL_CERT_FILE`，且两者的空值都视为未设置，
/// 避免调用方意外将 `VAR=""` 误解为无效路径进行查找。
///
/// 直接构造原始 `reqwest::Client` 的调用方会完全绕过该策略。这在新增 Codex 出站 HTTP 路径时
/// 是常见错误，且由此产生的 bug 只在 proxy 或 gateway 需要 custom root CA 的环境中才会暴露。
///
/// # Errors
///
/// 当配置的 CA 文件不可读、格式错误，或包含 `reqwest` 无法注册为 root 的 certificate block 时，
/// 返回 [`BuildCustomCaTransportError`]。
pub fn build_reqwest_client_with_custom_ca(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError> {
    build_reqwest_client_with_env(&ProcessEnv, builder)
}

/// 当配置了 Codex custom CA bundle 时，构造对应的 rustls client config。
///
/// 本函数是 [`build_reqwest_client_with_custom_ca`] 的 websocket 侧对应版本。当
/// `CODEX_CA_CERTIFICATE` 或 `SSL_CERT_FILE` 选定了 CA bundle 时，返回的 config 会以平台
/// native roots 为起点，再叠加配置的 custom CA certificates。当未设置任何 custom CA 环境变量时，
/// 返回 `Ok(None)`，使 websocket 调用方可以继续使用其普通的默认 connector 路径。
///
/// 让 tungstenite 直接构建其默认 TLS connector 的调用方会完全绕过该策略。该 bug 只在安全
/// websocket 流量需要与 HTTPS 流量相同的 enterprise root CA bundle 的环境中才会暴露。
pub fn maybe_build_rustls_client_config_with_custom_ca()
-> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError> {
    maybe_build_rustls_client_config_with_env(&ProcessEnv)
}

/// 为派生 subprocess 测试构造 reqwest client，用于验证 CA 行为。
///
/// 这是 `tests/` 下 subprocess 覆盖测试专用的 client 构造路径。模块级文档已完整说明 hermeticity
/// 问题；本 helper 仅通过禁用 proxy 自动探测来解决该问题中 reqwest proxy-discovery panic 的部分。
/// 测试本身仍需自行清除继承的 CA 环境变量。生产环境的常规调用方应使用
/// [`build_reqwest_client_with_custom_ca`]，避免测试专用的 proxy 行为泄漏到普通 client 构造中。
pub fn build_reqwest_client_for_subprocess_tests(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError> {
    build_reqwest_client_with_env(&ProcessEnv, builder.no_proxy())
}

fn maybe_build_rustls_client_config_with_env(
    env_source: &dyn EnvSource,
) -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError> {
    let Some(bundle) = env_source.configured_ca_bundle() else {
        return Ok(None);
    };

    ensure_rustls_crypto_provider();

    // 以 platform roots 作为起点，使 websocket 调用方保留与 tungstenite 默认 rustls connector
    // 相同的 baseline trust behavior；随后在已配置时叠加 Codex custom CA bundle。
    let mut root_store = RootCertStore::empty();
    let rustls_native_certs::CertificateResult { certs, errors, .. } =
        rustls_native_certs::load_native_certs();
    if !errors.is_empty() {
        warn!(
            native_root_error_count = errors.len(),
            "encountered errors while loading native root certificates"
        );
    }
    let _ = root_store.add_parsable_certificates(certs);

    let certificates = bundle.load_certificates()?;
    for (idx, cert) in certificates.into_iter().enumerate() {
        if let Err(source) = root_store.add(cert) {
            warn!(
                source_env = bundle.source_env,
                ca_path = %bundle.path.display(),
                certificate_index = idx + 1,
                error = %source,
                "failed to register CA certificate in rustls root store"
            );
            return Err(BuildCustomCaTransportError::RegisterRustlsCertificate {
                source_env: bundle.source_env,
                path: bundle.path.clone(),
                certificate_index: idx + 1,
                source,
            });
        }
    }

    Ok(Some(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    )))
}

/// 使用注入的 environment source 与 reqwest builder 构造 reqwest client。
///
/// 该函数存在的目的是让测试可以在不修改真实进程环境的前提下，确定性地验证优先级行为。它会：
/// 选定 CA bundle、将文件解析委托给 [`ConfiguredCaBundle::load_certificates`]、保留调用方选择的
/// `reqwest` builder 配置、在配置了 custom CA 时强制使用 rustls，最后将每个解析出的 certificate
/// 注册到该 builder。
fn build_reqwest_client_with_env(
    env_source: &dyn EnvSource,
    mut builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError> {
    if let Some(bundle) = env_source.configured_ca_bundle() {
        ensure_rustls_crypto_provider();
        info!(
            source_env = bundle.source_env,
            ca_path = %bundle.path.display(),
            "building HTTP client with rustls backend for custom CA bundle"
        );
        builder = builder.use_rustls_tls();

        let certificates = bundle.load_certificates()?;

        for (idx, cert) in certificates.iter().enumerate() {
            let certificate = match reqwest::Certificate::from_der(cert.as_ref()) {
                Ok(certificate) => certificate,
                Err(source) => {
                    warn!(
                        source_env = bundle.source_env,
                        ca_path = %bundle.path.display(),
                        certificate_index = idx + 1,
                        error = %source,
                        "failed to register CA certificate"
                    );
                    return Err(BuildCustomCaTransportError::RegisterCertificate {
                        source_env: bundle.source_env,
                        path: bundle.path.clone(),
                        certificate_index: idx + 1,
                        source,
                    });
                }
            };
            builder = builder.add_root_certificate(certificate);
        }
        return match builder.build() {
            Ok(client) => Ok(client),
            Err(source) => {
                warn!(
                    source_env = bundle.source_env,
                    ca_path = %bundle.path.display(),
                    error = %source,
                    "failed to build client after loading custom CA bundle"
                );
                Err(BuildCustomCaTransportError::BuildClientWithCustomCa {
                    source_env: bundle.source_env,
                    path: bundle.path.clone(),
                    source,
                })
            }
        };
    }

    info!(
        codex_ca_certificate_configured = false,
        ssl_cert_file_configured = false,
        "using system root certificates because no CA override environment variable was selected"
    );

    match builder.build() {
        Ok(client) => Ok(client),
        Err(source) => {
            warn!(
                error = %source,
                "failed to build client while using system root certificates"
            );
            Err(BuildCustomCaTransportError::BuildClientWithSystemRoots(
                source,
            ))
        }
    }
}

/// 对环境访问进行抽象，使测试能在不修改进程级变量的情况下覆盖优先级规则。
trait EnvSource {
    /// 返回 `key` 对应的环境变量值，若该 source 认为其未设置则返回 `None`。
    ///
    /// 实现应对缺失值返回 `None`，也可将不可读的进程环境状态归约为 `None`，因为 custom CA
    /// 逻辑将两种情况都视为"未配置 override"。调用方在该方法之上构建优先级与空字符串处理，
    /// 因此实现不应 trim 或归一化返回的字符串。
    fn var(&self, key: &str) -> Option<String>;

    /// 返回被解释为文件系统路径的非空环境变量值。
    ///
    /// 空字符串被视为未设置，因为此处的存在性充当"请求 custom CA override"的布尔信号。这避免
    /// 优先级逻辑将 `VAR=""` 误解为尝试打开当前工作目录或其他平台相关的怪异行为（一旦其被
    /// 转换为 path）。
    fn non_empty_path(&self, key: &str) -> Option<PathBuf> {
        self.var(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    /// 返回已配置的 CA bundle 以及选定它的环境变量名。
    ///
    /// `CODEX_CA_CERTIFICATE` 优先于 `SSL_CERT_FILE`，因为它是 Codex 专用的 override。
    /// 将胜出的变量名与 path 一并保留，使后续日志不仅能说明使用了哪个文件，还能说明为何选择该文件。
    fn configured_ca_bundle(&self) -> Option<ConfiguredCaBundle> {
        self.non_empty_path(CODEX_CA_CERT_ENV)
            .map(|path| ConfiguredCaBundle {
                source_env: CODEX_CA_CERT_ENV,
                path,
            })
            .or_else(|| {
                self.non_empty_path(SSL_CERT_FILE_ENV)
                    .map(|path| ConfiguredCaBundle {
                        source_env: SSL_CERT_FILE_ENV,
                        path,
                    })
            })
    }
}

/// 从真实进程环境中读取 CA 配置。
///
/// 这是 [`build_reqwest_client_with_custom_ca`] 使用的生产环境 `EnvSource` 实现。测试中会替换为
/// 内存中的 env map，以便在不修改进程级全局变量的情况下验证优先级与空值行为。
struct ProcessEnv;

impl EnvSource for ProcessEnv {
    fn var(&self, key: &str) -> Option<String> {
        env::var(key).ok()
    }
}

/// 标识为 client 选定的 CA bundle 以及选定它的策略决定。
///
/// 这是 environment-precedence 逻辑的具体输出。调用方使用 `source_env` 进行日志与诊断，
/// 而 `path` 是实际将被加载的 bundle。
struct ConfiguredCaBundle {
    /// 在优先级检查中胜出的环境变量名。
    source_env: &'static str,
    /// 应作为 PEM certificate input 读取的文件系统路径。
    path: PathBuf,
}

impl ConfiguredCaBundle {
    /// 从已选定的 CA bundle 中加载 certificate。
    ///
    /// 由于 bundle 已完成 environment-precedence 选择，本方法是文件加载阶段的自然入口。该方法
    /// 负责该阶段的高层成功/失败日志，并将 source env 与 path 一并保留，便于下游的解析与
    /// error shaping 使用。
    fn load_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError> {
        match self.parse_certificates() {
            Ok(certificates) => {
                info!(
                    source_env = self.source_env,
                    ca_path = %self.path.display(),
                    certificate_count = certificates.len(),
                    "loaded certificates from custom CA bundle"
                );
                Ok(certificates)
            }
            Err(error) => {
                warn!(
                    source_env = self.source_env,
                    ca_path = %self.path.display(),
                    error = %error,
                    "failed to load custom CA bundle"
                );
                Err(error)
            }
        }
    }

    /// 从用于 Codex CA override 的 PEM 文件中加载所有 certificate block。
    ///
    /// 本方法接受几种实际部署中常见的变体，使 Codex 与其他 CA-aware 工具行为一致：
    /// 保留前导注释、将 `TRUSTED CERTIFICATE` 标签归一化为标准 certificate 标签，
    /// 并在嵌入的 CRL 足够规范（能被 section iterator 正确分类）时将其忽略。
    fn parse_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError> {
        let pem_data = self.read_pem_data()?;
        let normalized_pem = NormalizedPem::from_pem_data(self.source_env, &self.path, &pem_data);

        let mut certificates = Vec::new();
        let mut logged_crl_presence = false;
        for section_result in normalized_pem.sections() {
            // 已知限制：若 `rustls-pki-types` 在解析格式错误的 CRL section 时失败，该错误会在此处
            // 被上报，此时我们尚无法将其分类为可忽略的 block。因此，包含有效 certificate 加上
            // 格式错误的 `X509 CRL` 的 bundle 目前仍会加载失败，尽管规范的 CRL 会被忽略。
            let (section_kind, der) = match section_result {
                Ok(section) => section,
                Err(error) => return Err(self.pem_parse_error(&error)),
            };
            match section_kind {
                SectionKind::Certificate => {
                    // 标准 CERTIFICATE block 已经解码为 reqwest 所需的精确 DER bytes。
                    // 只有 OpenSSL TRUSTED CERTIFICATE block 需要裁剪，以丢弃尾部的
                    // X509_AUX trust metadata 后再注册。
                    let cert_der = normalized_pem.certificate_der(&der).ok_or_else(|| {
                        self.invalid_ca_file(
                            "failed to extract certificate data from TRUSTED CERTIFICATE: invalid DER length",
                        )
                    })?;
                    certificates.push(CertificateDer::from(cert_der.to_vec()));
                }
                SectionKind::Crl if !logged_crl_presence => {
                    info!(
                        source_env = self.source_env,
                        ca_path = %self.path.display(),
                        "ignoring X509 CRL entries found in custom CA bundle"
                    );
                    logged_crl_presence = true;
                }
                _ => {}
            }
        }

        if certificates.is_empty() {
            return Err(self.pem_parse_error(&pem::Error::NoItemsFound));
        }

        Ok(certificates)
    }

    /// 读取 CA bundle 字节，同时保留原始文件系统错误类型。
    ///
    /// 调用方希望得到包含 bundle path 与 remediation hint 的面向用户的错误，但更高层的展示
    /// 仍需区分"文件未找到"与其他 I/O 失败。本 helper 同时保留这两部分信息。
    fn read_pem_data(&self) -> Result<Vec<u8>, BuildCustomCaTransportError> {
        fs::read(&self.path).map_err(|source| BuildCustomCaTransportError::ReadCaFile {
            source_env: self.source_env,
            path: self.path.clone(),
            source,
        })
    }

    /// 将 PEM 解析失败改写为面向用户的配置错误。
    ///
    /// 底层 parser 知道文件是空的、格式错误还是包含不支持的 PEM content，但调用方需要的消息
    /// 还应指引其关注相关环境变量与预期的 remediation。
    fn pem_parse_error(&self, error: &pem::Error) -> BuildCustomCaTransportError {
        let detail = match error {
            pem::Error::NoItemsFound => "no certificates found in PEM file".to_string(),
            _ => format!("failed to parse PEM file: {error}"),
        };

        self.invalid_ca_file(detail)
    }

    /// 创建与该文件路径关联的 invalid-CA 错误。
    ///
    /// 本模块中大多数解析期失败最终都归结为"配置的 CA bundle 不可用"，但具体原因对运维排查
    /// 仍然重要。集中处理该格式化逻辑可确保不同 parser 分支中的 path 与 hint 文本保持一致。
    fn invalid_ca_file(&self, detail: impl std::fmt::Display) -> BuildCustomCaTransportError {
        BuildCustomCaTransportError::InvalidCaFile {
            source_env: self.source_env,
            path: self.path.clone(),
            detail: detail.to_string(),
        }
    }
}

/// OpenSSL 兼容归一化后的 PEM 文本 shape。
///
/// `Standard` 表示输入已使用普通 PEM certificate 标签。`TrustedCertificate` 表示输入使用了
/// OpenSSL 的 `TRUSTED CERTIFICATE` 标签，因此调用方还需准备好裁剪已解码 certificate section
/// 尾部的 `X509_AUX` bytes。
enum NormalizedPem {
    /// 已使用普通 `CERTIFICATE` 标签的 PEM 内容。
    Standard(String),
    /// 从 OpenSSL `TRUSTED CERTIFICATE` 标签改写为 `CERTIFICATE` 的 PEM 内容。
    TrustedCertificate(String),
}

impl NormalizedPem {
    /// 将 CA bundle 的 PEM 文本归一化为本模块期望的标签 shape。
    ///
    /// Codex 只需 certificate DER bytes 来初始化 `reqwest` 的 root store，但运维人员可能将
    /// 其指向来自 OpenSSL 工具而非最小 certificate bundle 的 CA 文件。OpenSSL 的
    /// `TRUSTED CERTIFICATE` 形式即为此类变体：它仍是 certificate material，但使用不同的 PEM
    /// 标签，且可能携带本 crate 不使用的辅助 trust metadata。该构造函数仅改写 PEM 标签，
    /// 使 mixed-section parser 能继续将该文件视为 certificate input。rustls 生态目前尚不接受
    /// `TRUSTED CERTIFICATE` 作为标准 certificate 标签，因此这仍是本地兼容 shim，而非委托给
    /// `rustls-pki-types` 的行为。
    ///
    /// 另见：
    /// - rustls/pemfile issue #52，已关闭且不予实现，文档记录了 `BEGIN TRUSTED CERTIFICATE`
    ///   block 在上游会被忽略：<https://github.com/rustls/pemfile/issues/52>
    /// - OpenSSL `x509 -trustout`，会输出 `TRUSTED CERTIFICATE` PEM block：
    ///   <https://docs.openssl.org/master/man1/openssl-x509/>
    /// - OpenSSL PEM reader，文档记录了普通 `PEM_read_bio_X509()` 会丢弃辅助 trust 设置：
    ///   <https://docs.openssl.org/master/man3/PEM_read_bio_PrivateKey/>
    /// - `openssl s_server`，一个基于 OpenSSL 的真实 server/test 工具，运行于该生态中：
    ///   <https://docs.openssl.org/master/man1/openssl-s_server/>
    fn from_pem_data(source_env: &'static str, path: &Path, pem_data: &[u8]) -> Self {
        let pem = String::from_utf8_lossy(pem_data);
        if pem.contains("TRUSTED CERTIFICATE") {
            info!(
                source_env,
                ca_path = %path.display(),
                "normalizing OpenSSL TRUSTED CERTIFICATE labels in custom CA bundle"
            );
            Self::TrustedCertificate(
                pem.replace("BEGIN TRUSTED CERTIFICATE", "BEGIN CERTIFICATE")
                    .replace("END TRUSTED CERTIFICATE", "END CERTIFICATE"),
            )
        } else {
            Self::Standard(pem.into_owned())
        }
    }

    /// 返回归一化后的 PEM 内容，不区分产生它的标签 shape。
    fn contents(&self) -> &str {
        match self {
            Self::Standard(contents) | Self::TrustedCertificate(contents) => contents,
        }
    }

    /// 遍历该归一化 PEM 文本中所有已识别的 PEM section。
    ///
    /// `rustls-pki-types` 通过 `(SectionKind, Vec<u8>)` tuple 上的 `PemObject` 实现暴露
    /// mixed-section 解析。在此保留该 type-directed API，使调用方可以按归一化后的 section 进行
    /// 迭代，而不必关心 trait 底层管线。
    fn sections(&self) -> impl Iterator<Item = Result<PemSection, pem::Error>> + '_ {
        PemSection::pem_slice_iter(self.contents().as_bytes())
    }

    /// 返回单个已解析 PEM certificate section 的 certificate DER bytes。
    ///
    /// 标准 PEM certificate 已解码为 `reqwest` 所需的精确 DER bytes。OpenSSL
    /// `TRUSTED CERTIFICATE` section 可能在 certificate 后追加 `X509_AUX` bytes，因此这类
    /// section 需要先裁剪到首个 DER object 再进行注册。
    fn certificate_der<'a>(&self, der: &'a [u8]) -> Option<&'a [u8]> {
        match self {
            Self::Standard(_) => Some(der),
            Self::TrustedCertificate(_) => first_der_item(der),
        }
    }
}

/// 返回 `der` 中第一个 DER 编码的 ASN.1 object，忽略尾部的 OpenSSL metadata。
///
/// 一个 PEM `CERTIFICATE` block 通常解码为恰好一个 DER blob：certificate 本身。
/// OpenSSL 的 `TRUSTED CERTIFICATE` 变体则不同。它以相同的 certificate blob 开头，
/// 但可能在其后追加额外的 `X509_AUX` bytes，用于描述 OpenSSL 特定的 trust 设置。
/// `reqwest::Certificate::from_der` 只理解 certificate object，不理解这些尾部 OpenSSL 扩展。
///
/// 因此本 helper 提出的是一个比"这是否是有效 certificate？"更窄的问题：第一个顶层 DER object
/// 在哪里结束？若能找到该边界，调用方只保留该前缀并丢弃尾部 trust metadata。若无法找到，
/// 则将输入视为格式错误的 CA 数据。
fn first_der_item(der: &[u8]) -> Option<&[u8]> {
    der_item_length(der).map(|length| &der[..length])
}

/// 返回 `der` 中第一个 DER item 的字节长度。
///
/// DER 是 ASN.1 object 的二进制编码。每个 object 以如下结构开始：
///
/// - 一个 tag byte，描述后续 object 的类型
/// - 一个或多个 length bytes，描述该 object 包含多少 content bytes
/// - content bytes 本身
///
/// 对于本模块而言，关键事实是：一个 certificate 作为一个完整的顶层 DER object 存储。
/// 一旦知道该 object 声明的长度，就能精确知道 certificate 在哪里结束、尾部 OpenSSL
/// `X509_AUX` 数据从哪里开始。
///
/// 本 helper 有意只解析外层 length 字段，不校验内部 certificate 结构、tag 含义或每个嵌套
/// ASN.1 value。该窄范围是有意为之：调用方只需要前导 certificate object 的安全切片边界，
/// 随后将这些 bytes 交给 `reqwest`，由其执行真正的 certificate 解析。
///
/// 实现支持此处所需的 DER length forms：
///
/// - short form：长度直接存储在第二个 byte 中
/// - long form：第二个 byte 表示后续多少个 bytes 组成 length value
///
/// Indefinite lengths 会被拒绝，因为 DER 不允许该形式；任何声明长度超出输入末尾的情况
/// 都被视为格式错误。
fn der_item_length(der: &[u8]) -> Option<usize> {
    let &length_octet = der.get(1)?;
    if length_octet & 0x80 == 0 {
        return Some(2 + usize::from(length_octet)).filter(|length| *length <= der.len());
    }

    let length_octets = usize::from(length_octet & 0x7f);
    if length_octets == 0 {
        return None;
    }

    let length_start = 2usize;
    let length_end = length_start.checked_add(length_octets)?;
    let length_bytes = der.get(length_start..length_end)?;
    let mut content_length = 0usize;
    for &byte in length_bytes {
        content_length = content_length
            .checked_mul(256)?
            .checked_add(usize::from(byte))?;
    }

    length_end
        .checked_add(content_length)
        .filter(|length| *length <= der.len())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::BuildCustomCaTransportError;
    use super::CODEX_CA_CERT_ENV;
    use super::EnvSource;
    use super::SSL_CERT_FILE_ENV;
    use super::maybe_build_rustls_client_config_with_env;

    const TEST_CERT: &str = include_str!("../tests/fixtures/test-ca.pem");

    struct MapEnv {
        values: HashMap<String, String>,
    }

    impl EnvSource for MapEnv {
        fn var(&self, key: &str) -> Option<String> {
            self.values.get(key).cloned()
        }
    }

    fn map_env(pairs: &[(&str, &str)]) -> MapEnv {
        MapEnv {
            values: pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        }
    }

    fn write_cert_file(temp_dir: &TempDir, name: &str, contents: &str) -> PathBuf {
        let path = temp_dir.path().join(name);
        fs::write(&path, contents).unwrap_or_else(|error| {
            panic!("write cert fixture failed for {}: {error}", path.display())
        });
        path
    }

    #[test]
    fn ca_path_prefers_codex_env() {
        let env = map_env(&[
            (CODEX_CA_CERT_ENV, "/tmp/codex.pem"),
            (SSL_CERT_FILE_ENV, "/tmp/fallback.pem"),
        ]);

        assert_eq!(
            env.configured_ca_bundle().map(|bundle| bundle.path),
            Some(PathBuf::from("/tmp/codex.pem"))
        );
    }

    #[test]
    fn ca_path_falls_back_to_ssl_cert_file() {
        let env = map_env(&[(SSL_CERT_FILE_ENV, "/tmp/fallback.pem")]);

        assert_eq!(
            env.configured_ca_bundle().map(|bundle| bundle.path),
            Some(PathBuf::from("/tmp/fallback.pem"))
        );
    }

    #[test]
    fn ca_path_ignores_empty_values() {
        let env = map_env(&[
            (CODEX_CA_CERT_ENV, ""),
            (SSL_CERT_FILE_ENV, "/tmp/fallback.pem"),
        ]);

        assert_eq!(
            env.configured_ca_bundle().map(|bundle| bundle.path),
            Some(PathBuf::from("/tmp/fallback.pem"))
        );
    }

    #[test]
    fn rustls_config_uses_custom_ca_bundle_when_configured() {
        let temp_dir = TempDir::new().expect("tempdir");
        let cert_path = write_cert_file(&temp_dir, "ca.pem", TEST_CERT);
        let env = map_env(&[(CODEX_CA_CERT_ENV, cert_path.to_string_lossy().as_ref())]);

        let config = maybe_build_rustls_client_config_with_env(&env)
            .expect("rustls config")
            .expect("custom CA config should be present");

        assert!(config.enable_sni);
    }

    #[test]
    fn rustls_config_reports_invalid_ca_file() {
        let temp_dir = TempDir::new().expect("tempdir");
        let cert_path = write_cert_file(&temp_dir, "empty.pem", "");
        let env = map_env(&[(CODEX_CA_CERT_ENV, cert_path.to_string_lossy().as_ref())]);

        let error = maybe_build_rustls_client_config_with_env(&env).expect_err("invalid CA");

        assert!(matches!(
            error,
            BuildCustomCaTransportError::InvalidCaFile { .. }
        ));
    }
}
