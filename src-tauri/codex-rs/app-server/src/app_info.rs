use codex_app_server_protocol::AppBranding as ApiAppBranding;
use codex_app_server_protocol::AppInfo as ApiAppInfo;
use codex_app_server_protocol::AppMetadata as ApiAppMetadata;
use codex_app_server_protocol::AppReview as ApiAppReview;
use codex_app_server_protocol::AppScreenshot as ApiAppScreenshot;
use codex_connectors::AppBranding;
use codex_connectors::AppInfo;
use codex_connectors::AppMetadata;
use codex_connectors::AppReview;
use codex_connectors::AppScreenshot;

/// 将 connector 域拥有的 app 元数据（`codex-connectors`）转换为 app-server 线协议类型
/// （`codex-app-server-protocol`）。
///
/// 两类类型保持独立，避免 app-server 协议的所有权泄漏到 connector 域 crate 中。
/// 由于本 crate 不拥有任何一方类型，受 Rust orphan rules 限制，必须使用显式转换函数
/// 而不能实现 `From` trait。
///
/// # 参数
///
/// - `app`: connector 域的 `AppInfo` 实例
///
/// # 返回值
///
/// 返回 app-server 协议层的 `ApiAppInfo`，字段一一对应转换。
pub(crate) fn app_info_to_api(app: AppInfo) -> ApiAppInfo {
    let AppInfo {
        id,
        name,
        description,
        logo_url,
        logo_url_dark,
        icon_assets,
        icon_dark_assets,
        distribution_channel,
        branding,
        app_metadata,
        labels,
        install_url,
        is_accessible,
        is_enabled,
        plugin_display_names,
    } = app;
    ApiAppInfo {
        id,
        name,
        description,
        logo_url,
        logo_url_dark,
        icon_assets,
        icon_dark_assets,
        distribution_channel,
        branding: branding.map(app_branding_to_api),
        app_metadata: app_metadata.map(app_metadata_to_api),
        labels,
        install_url,
        is_accessible,
        is_enabled,
        plugin_display_names,
    }
}

/// 将 connector 域的品牌信息（`AppBranding`）转换为 app-server 协议类型。
///
/// 字段一一对应转换。详见 [`app_info_to_api`] 关于类型分离与 orphan rules 的说明。
fn app_branding_to_api(branding: AppBranding) -> ApiAppBranding {
    let AppBranding {
        category,
        developer,
        website,
        privacy_policy,
        terms_of_service,
        is_discoverable_app,
    } = branding;
    ApiAppBranding {
        category,
        developer,
        website,
        privacy_policy,
        terms_of_service,
        is_discoverable_app,
    }
}

/// 将 connector 域的 app 审核信息（`AppReview`）转换为 app-server 协议类型。
///
/// 字段一一对应转换。详见 [`app_info_to_api`] 关于类型分离与 orphan rules 的说明。
fn app_review_to_api(review: AppReview) -> ApiAppReview {
    let AppReview { status } = review;
    ApiAppReview { status }
}

/// 将 connector 域的应用截图（`AppScreenshot`）转换为 app-server 协议类型。
///
/// 字段一一对应转换。详见 [`app_info_to_api`] 关于类型分离与 orphan rules 的说明。
fn app_screenshot_to_api(screenshot: AppScreenshot) -> ApiAppScreenshot {
    let AppScreenshot {
        url,
        file_id,
        user_prompt,
    } = screenshot;
    ApiAppScreenshot {
        url,
        file_id,
        user_prompt,
    }
}

/// 将 connector 域的 app 完整元数据（`AppMetadata`）转换为 app-server 协议类型。
///
/// 该结构包含审核信息、分类、SEO 描述、截图、版本信息等。嵌套类型（`review`、
/// `screenshots`）会递归调用对应的转换函数。
///
/// 详见 [`app_info_to_api`] 关于类型分离与 orphan rules 的说明。
fn app_metadata_to_api(metadata: AppMetadata) -> ApiAppMetadata {
    let AppMetadata {
        review,
        categories,
        sub_categories,
        seo_description,
        screenshots,
        developer,
        version,
        version_id,
        version_notes,
        first_party_type,
        first_party_requires_install,
        show_in_composer_when_unlinked,
    } = metadata;
    ApiAppMetadata {
        review: review.map(app_review_to_api),
        categories,
        sub_categories,
        seo_description,
        screenshots: screenshots
            .map(|screenshots| screenshots.into_iter().map(app_screenshot_to_api).collect()),
        developer,
        version,
        version_id,
        version_notes,
        first_party_type,
        first_party_requires_install,
        show_in_composer_when_unlinked,
    }
}
