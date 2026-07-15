use codex_app_server_protocol::ConfigLayer as ApiConfigLayer;
use codex_app_server_protocol::ConfigLayerMetadata as ApiConfigLayerMetadata;
use codex_app_server_protocol::ConfigLayerSource as ApiConfigLayerSource;
use codex_config::ConfigLayer;
use codex_config::ConfigLayerMetadata;
use codex_config::ConfigLayerSource;

/// 将 `codex-config` 拥有的 config-layer source 转换为 `codex-app-server-protocol`
/// 拥有的 app-server wire type。
///
/// 这些类型保持独立，以免 app-server protocol 的所有权泄露到 config domain crate 中。
/// 由于本 crate 不拥有其中任何一个类型，Rust 的 orphan rules 要求使用显式转换函数，
/// 而不能使用 `From` implementation。
pub(crate) fn config_layer_source_to_api(source: ConfigLayerSource) -> ApiConfigLayerSource {
    match source {
        ConfigLayerSource::Mdm { domain, key } => ApiConfigLayerSource::Mdm { domain, key },
        ConfigLayerSource::System { file } => ApiConfigLayerSource::System { file },
        ConfigLayerSource::EnterpriseManaged { id, name } => {
            ApiConfigLayerSource::EnterpriseManaged { id, name }
        }
        ConfigLayerSource::User { file, profile } => ApiConfigLayerSource::User { file, profile },
        ConfigLayerSource::Project { dot_codex_folder } => {
            ApiConfigLayerSource::Project { dot_codex_folder }
        }
        ConfigLayerSource::SessionFlags => ApiConfigLayerSource::SessionFlags,
        ConfigLayerSource::LegacyManagedConfigTomlFromFile { file } => {
            ApiConfigLayerSource::LegacyManagedConfigTomlFromFile { file }
        }
        ConfigLayerSource::LegacyManagedConfigTomlFromMdm => {
            ApiConfigLayerSource::LegacyManagedConfigTomlFromMdm
        }
    }
}

/// 将 `codex-config` 拥有的 config-layer metadata 转换为 `codex-app-server-protocol`
/// 拥有的 app-server wire type。
///
/// 这些类型保持独立，以免 app-server protocol 的所有权泄露到 config domain crate 中。
/// 由于本 crate 不拥有其中任何一个类型，Rust 的 orphan rules 要求使用显式转换函数，
/// 而不能使用 `From` implementation。
pub(crate) fn config_layer_metadata_to_api(
    metadata: ConfigLayerMetadata,
) -> ApiConfigLayerMetadata {
    ApiConfigLayerMetadata {
        name: config_layer_source_to_api(metadata.name),
        version: metadata.version,
    }
}

/// 将 `codex-config` 拥有的 config layer 转换为 `codex-app-server-protocol`
/// 拥有的 app-server wire type。
///
/// 这些类型保持独立，以免 app-server protocol 的所有权泄露到 config domain crate 中。
/// 由于本 crate 不拥有其中任何一个类型，Rust 的 orphan rules 要求使用显式转换函数，
/// 而不能使用 `From` implementation。
pub(crate) fn config_layer_to_api(layer: ConfigLayer) -> ApiConfigLayer {
    ApiConfigLayer {
        name: config_layer_source_to_api(layer.name),
        version: layer.version,
        config: layer.config,
        disabled_reason: layer.disabled_reason,
    }
}
