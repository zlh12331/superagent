//! OpenAI 搜索 API 请求与响应类型定义模块。
//!
//! ## 职责
//!
//! 定义与 OpenAI 搜索 API 交互所需的所有数据结构，包括：
//! - 搜索请求（[`SearchRequest`]）：包含查询、命令、设置等
//! - 搜索命令（[`SearchCommands`]）：支持搜索、图片、打开页面、点击、查找、截图、
//!   财经、天气、体育、时间等多种操作
//! - 搜索设置（[`SearchSettings`]）：地理位置、上下文大小、过滤器等
//! - 搜索响应（[`SearchResponse`]）：包含加密输出与明文输出
//!
//! ## 架构位置
//!
//! 这些类型用于构造发送到 OpenAI 搜索端点的 JSON 请求体，并由
//! `codex-api` 的传输层序列化后发送。响应体反序列化为
//! [`SearchResponse`] 后交由上层逻辑处理。

use crate::common::Reasoning;
use codex_protocol::models::ResponseItem;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

/// OpenAI 搜索 API 请求载荷。
///
/// 包含模型、可选的推理参数、输入（文本或 ResponseItem 列表）、
/// 命令（多种搜索操作）、设置（地理位置、过滤器等）与输出 token 上限。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchRequest {
    /// 请求的唯一标识符。
    pub id: String,
    /// 用于本次搜索的模型名称。
    pub model: String,
    /// 可选的推理参数（如 reasoning effort）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    /// 可选的输入内容：纯文本或 ResponseItem 列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<SearchInput>,
    /// 可选的搜索命令集合（搜索、图片、打开页面等）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<SearchCommands>,
    /// 可选的搜索设置（地理位置、上下文大小、过滤器等）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<SearchSettings>,
    /// 输出 token 数量上限。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

/// 搜索请求的输入内容。
///
/// 支持两种形式：
/// - [`SearchInput::Text`]：纯文本字符串
/// - [`SearchInput::Items`]：`ResponseItem` 列表（结构化输入）
///
/// 使用 `#[serde(untagged)]` 实现无标签的多态反序列化。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum SearchInput {
    /// 纯文本输入。
    Text(String),
    /// 结构化 ResponseItem 列表输入。
    Items(Vec<ResponseItem>),
}

/// 搜索命令集合。
///
/// 包含多种操作类型，每个字段对应一类操作，所有字段均可选。
/// 实现了 [`Default`]（所有字段为 `None`），便于按需构建。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, JsonSchema)]
pub struct SearchCommands {
    /// 向互联网搜索引擎发起查询的查询列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_query: Option<Vec<SearchQuery>>,
    /// 向图片搜索引擎发起查询的查询列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_query: Option<Vec<SearchQuery>>,
    /// 通过 reference id 或 URL 打开页面。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<Vec<OpenOperation>>,
    /// 从已打开的页面中点击链接。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<Vec<ClickOperation>>,
    /// 在页面中查找文本模式。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub find: Option<Vec<FindOperation>>,
    /// 对 PDF 页面截图。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<Vec<ScreenshotOperation>>,
    /// 查询给定股票代码的价格。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finance: Option<Vec<FinanceOperation>>,
    /// 查询天气预报。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather: Option<Vec<WeatherOperation>>,
    /// 查询体育赛程与排名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sports: Option<Vec<SportsOperation>>,
    /// 根据给定 UTC 偏移量查询时间。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<Vec<TimeOperation>>,
    /// 设置返回响应的长度。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_length: Option<SearchResponseLength>,
}

/// 单个搜索查询。
///
/// 用于 [`SearchCommands::search_query`] 与 [`SearchCommands::image_query`]，
/// 支持按时间范围与域名过滤。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct SearchQuery {
    /// 搜索查询字符串。
    pub q: String,
    /// 按时间范围过滤：最近多少天内的结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency: Option<u64>,
    /// 按域名过滤：仅返回指定域名列表中的结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<String>>,
}

/// "打开页面" 操作。
///
/// 通过 reference id 或 URL 打开一个页面，可选地定位到指定行号。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct OpenOperation {
    /// 要打开的 reference id 或 URL。
    pub ref_id: String,
    /// 页面定位到的行号。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineno: Option<u64>,
}

/// "点击链接" 操作。
///
/// 从先前打开的页面中点击一个带编号的链接。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct ClickOperation {
    /// 包含带编号链接的页面 reference id。
    pub ref_id: String,
    /// 要打开的带编号链接的 id。
    pub id: u64,
}

/// "查找文本" 操作。
///
/// 在指定页面中查找文本模式。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct FindOperation {
    /// 要在其中查找的页面 reference id 或 URL。
    pub ref_id: String,
    /// 要查找的文本模式。
    pub pattern: String,
}

/// "截图" 操作。
///
/// 对 PDF 页面进行截图。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct ScreenshotOperation {
    /// 要截图的页面 reference id 或 URL。
    pub ref_id: String,
    /// PDF 页码（从 0 开始计数）。
    pub pageno: u64,
}

/// "财经查询" 操作。
///
/// 查询给定股票代码的价格信息。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct FinanceOperation {
    /// 要查询的股票代码（ticker symbol）。
    pub ticker: String,
    /// 要查询的资产类型。
    pub r#type: FinanceAssetType,
    /// ISO 3166-1 alpha-3 国家代码，"OTC" 表示场外交易，"" 表示加密货币。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market: Option<String>,
}

/// 财经资产类型枚举。
///
/// 序列化为小写形式（如 `"equity"`、`"crypto"`）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FinanceAssetType {
    /// 股票。
    Equity,
    /// 基金。
    Fund,
    /// 加密货币。
    Crypto,
    /// 指数。
    Index,
}

/// "天气查询" 操作。
///
/// 查询指定地点的天气预报。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct WeatherOperation {
    /// 地点，格式为 "Country, Area, City"。
    pub location: String,
    /// 起始日期，格式为 YYYY-MM-DD，默认为今天。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// 返回的天数，默认为 7。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}

/// "体育查询" 操作。
///
/// 查询体育赛程与排名，支持按联盟、队伍、对手、日期等条件过滤。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct SportsOperation {
    /// 体育请求的工具名称。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<SportsToolName>,
    /// 要调用的体育功能。
    pub r#fn: SportsFunction,
    /// 要查询的联盟。
    pub league: SportsLeague,
    /// 要查询的队伍，使用广播中常见的 3 或 4 字母别名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// 与 `team` 配合使用以缩小查询范围的对手队伍。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opponent: Option<String>,
    /// 起始日期，格式为 YYYY-MM-DD。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_from: Option<String>,
    /// 结束日期，格式为 YYYY-MM-DD。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_to: Option<String>,
    /// 返回的比赛场数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_games: Option<u64>,
    /// 查询使用的区域设置（locale）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

/// 体育请求的工具名称枚举。
///
/// 序列化为小写形式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SportsToolName {
    /// 体育工具。
    Sports,
}

/// 体育功能枚举。
///
/// 序列化为小写形式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SportsFunction {
    /// 赛程查询。
    Schedule,
    /// 排名查询。
    Standings,
}

/// 体育联盟枚举。
///
/// 序列化为小写形式，涵盖主流体育联盟。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SportsLeague {
    /// 美国职业篮球联赛。
    Nba,
    /// 美国女子职业篮球联赛。
    Wnba,
    /// 美国职业橄榄球联赛。
    Nfl,
    /// 国家冰球联盟。
    Nhl,
    /// 美国职业棒球大联盟。
    Mlb,
    /// 英格兰足球超级联赛。
    Epl,
    /// NCAA 男子篮球。
    Ncaamb,
    /// NCAA 女子篮球。
    Ncaawb,
    /// 印度板球超级联赛。
    Ipl,
}

/// "时间查询" 操作。
///
/// 根据给定 UTC 偏移量查询当前时间。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct TimeOperation {
    /// UTC 偏移量，格式如 "+03:00"。
    pub utc_offset: String,
}

/// 搜索响应长度枚举。
///
/// 序列化为小写形式，用于控制返回响应的长度。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SearchResponseLength {
    /// 短。
    Short,
    /// 中。
    Medium,
    /// 长。
    Long,
}

/// 外部 Web 访问模式枚举。
///
/// 序列化为 snake_case 形式，控制搜索引擎访问外部 Web 内容的方式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalWebAccessMode {
    /// 仅访问缓存内容。
    Cached,
    /// 访问已索引的内容。
    Indexed,
    /// 实时访问外部 Web。
    Live,
}

/// 外部 Web 访问配置。
///
/// 支持两种形式：
/// - [`ExternalWebAccess::Boolean`]：直接用布尔值启用 / 禁用
/// - [`ExternalWebAccess::Mode`]：指定访问模式
///
/// 使用 `#[serde(untagged)]` 实现无标签的多态反序列化。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(untagged)]
pub enum ExternalWebAccess {
    /// 布尔值：是否允许外部 Web 访问。
    Boolean(bool),
    /// 指定访问模式。
    Mode(ExternalWebAccessMode),
}

/// 搜索设置。
///
/// 包含地理位置、上下文大小、过滤器、图片设置、允许的调用者与外部 Web 访问配置。
/// 实现了 [`Default`]（所有字段为 `None`），便于按需构建。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SearchSettings {
    /// 用户近似地理位置。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_location: Option<ApproximateLocation>,
    /// 搜索上下文大小（影响搜索结果的信息量）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_context_size: Option<SearchContextSize>,
    /// 搜索过滤器（允许 / 屏蔽的域名）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<SearchFilters>,
    /// 图片搜索设置。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_settings: Option<SearchImageSettings>,
    /// 允许调用搜索的调用者列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_callers: Option<Vec<AllowedCaller>>,
    /// 外部 Web 访问配置。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_web_access: Option<ExternalWebAccess>,
}

/// 用户近似地理位置。
///
/// 用于搜索结果的地理相关性与本地化。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApproximateLocation {
    /// 地理位置类型。
    pub r#type: LocationType,
    /// 国家（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    /// 地区（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// 城市（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    /// 时区（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// 地理位置类型枚举。
///
/// 序列化为小写形式，目前仅支持 `approximate`。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocationType {
    /// 近似位置。
    Approximate,
}

/// 搜索上下文大小枚举。
///
/// 序列化为小写形式，控制搜索结果提供的信息量。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchContextSize {
    /// 低（较少信息）。
    Low,
    /// 中。
    Medium,
    /// 高（较多信息）。
    High,
}

/// 搜索过滤器。
///
/// 通过允许 / 屏蔽域名列表来限制搜索结果来源。
/// 实现了 [`Default`]（两个列表均为 `None`），便于按需构建。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SearchFilters {
    /// 允许的域名列表：仅返回这些域名的结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Vec<String>>,
    /// 屏蔽的域名列表：排除这些域名的结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_domains: Option<Vec<String>>,
}

/// 图片搜索设置。
///
/// 控制图片搜索结果的数量与是否附带说明文字。
/// 实现了 [`Default`]（所有字段为 `None`），便于按需构建。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SearchImageSettings {
    /// 图片搜索结果的最大数量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u64>,
    /// 是否为图片结果附带说明文字。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<bool>,
}

/// 允许的搜索调用者枚举。
///
/// 序列化为 snake_case 形式，用于限制可发起搜索的调用者类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AllowedCaller {
    /// 直接调用。
    Direct,
    /// Shell 调用。
    Shell,
    /// 代码解释器调用。
    CodeInterpreter,
}

/// OpenAI 搜索 API 响应体。
///
/// 包含可选的加密输出与明文输出。当启用加密输出时，
/// `encrypted_output` 字段携带加密后的响应内容，由客户端解密后使用。
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SearchResponse {
    /// 加密的响应输出（可选）。
    pub encrypted_output: Option<String>,
    /// 明文的响应输出。
    pub output: String,
}
