//! 加载 AWS SDK 配置、凭证 provider 与 region 的内部辅助函数。

use aws_config::BehaviorVersion;
use aws_config::SdkConfig;
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_types::region::Region;

use crate::AwsAuthConfig;
use crate::AwsAuthError;

/// 根据 [`AwsAuthConfig`] 加载 AWS SDK 配置。
///
/// 若 `service` 为空（trim 后），直接返回 [`AwsAuthError::EmptyService`]。
pub(crate) async fn load_sdk_config(config: &AwsAuthConfig) -> Result<SdkConfig, AwsAuthError> {
    if config.service.trim().is_empty() {
        return Err(AwsAuthError::EmptyService);
    }

    let mut loader = aws_config::defaults(BehaviorVersion::latest());
    if let Some(profile) = config.profile.as_ref() {
        loader = loader.profile_name(profile);
    }
    if let Some(region) = config.region.as_ref() {
        loader = loader.region(Region::new(region.clone()));
    }

    Ok(loader.load().await)
}

/// 从 SDK 配置中取出 credentials provider，缺失则返回错误。
pub(crate) fn credentials_provider(
    sdk_config: &SdkConfig,
) -> Result<SharedCredentialsProvider, AwsAuthError> {
    sdk_config
        .credentials_provider()
        .ok_or(AwsAuthError::MissingCredentialsProvider)
}

/// 从 SDK 配置中解析出 region 字符串，缺失则返回错误。
pub(crate) fn resolved_region(sdk_config: &SdkConfig) -> Result<String, AwsAuthError> {
    sdk_config
        .region()
        .map(ToString::to_string)
        .ok_or(AwsAuthError::MissingRegion)
}
