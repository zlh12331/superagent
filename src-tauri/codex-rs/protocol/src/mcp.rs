//! 在 Codex 协议中表示 Model Context Protocol (MCP) 值的类型定义。
//!
//! 这些类型刻意保持对 TS / JSON Schema 友好（通过 `ts-rs` 与 `schemars`），
//! 以便直接嵌入 Codex 自身的协议结构。模块同时提供适配器函数，将 MCP wire
//! JSON（通常来自 rmcp 模型结构经 serde 序列化）转换为这里的协议类型。
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// MCP 请求 ID，可以是字符串或整数。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RequestId {
    /// 字符串形式的请求 ID。
    String(String),
    /// 整数形式的请求 ID。
    #[ts(type = "number")]
    Integer(i64),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestId::String(s) => f.write_str(s),
            RequestId::Integer(i) => i.fmt(f),
        }
    }
}

/// 已初始化 MCP server 对外通告的展示元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    /// server 名称（标识符）。
    pub name: String,
    /// 人类可读的展示标题。
    pub title: Option<String>,
    /// server 版本号。
    pub version: String,
    /// server 描述。
    pub description: Option<String>,
    /// 图标列表（JSON 值，由客户端解释）。
    pub icons: Option<Vec<serde_json::Value>>,
    /// server 网站 URL。
    pub website_url: Option<String>,
}

/// 客户端可调用的 tool 定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// tool 名称（在所在 server 内唯一）。
    pub name: String,
    /// 人类可读的展示标题。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// tool 用途描述，供模型理解。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// 输入参数的 JSON Schema。
    pub input_schema: serde_json::Value,
    /// 输出结构的 JSON Schema（若 server 提供）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output_schema: Option<serde_json::Value>,
    /// tool 注解（如 readOnlyHint / destructiveHint 等行为提示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotations: Option<serde_json::Value>,
    /// 图标列表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icons: Option<Vec<serde_json::Value>>,
    /// server 自定义的 `_meta` 扩展字段。
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meta: Option<serde_json::Value>,
}

/// server 能读取的已知资源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    /// 资源注解。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotations: Option<serde_json::Value>,
    /// 资源描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// 资源的 MIME 类型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
    /// 资源名称。
    pub name: String,
    /// 资源大小（字节数），可能因溢出 i64 而丢失为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub size: Option<i64>,
    /// 人类可读的展示标题。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// 资源 URI。
    pub uri: String,
    /// 图标列表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icons: Option<Vec<serde_json::Value>>,
    /// server 自定义的 `_meta` 扩展字段。
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meta: Option<serde_json::Value>,
}

/// 从 MCP server 读取资源时返回的内容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum ResourceContent {
    /// 文本资源内容。
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Text {
        /// 资源 URI。
        uri: String,
        /// 可选 MIME 类型。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mime_type: Option<String>,
        /// 文本内容。
        text: String,
        /// server 自定义的 `_meta` 扩展字段。
        #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        meta: Option<serde_json::Value>,
    },
    /// 二进制资源内容（base64 编码字符串）。
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Blob {
        /// 资源 URI。
        uri: String,
        /// 可选 MIME 类型。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mime_type: Option<String>,
        /// base64 编码的二进制内容。
        blob: String,
        /// server 自定义的 `_meta` 扩展字段。
        #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        meta: Option<serde_json::Value>,
    },
}

/// server 上可用资源的模板描述（用于参数化资源 URI）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTemplate {
    /// 资源注解。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub annotations: Option<serde_json::Value>,
    /// URI 模板（RFC 6570 格式，如 `/file/{path}`）。
    pub uri_template: String,
    /// 模板名称。
    pub name: String,
    /// 人类可读的展示标题。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// 模板描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// 匹配资源的 MIME 类型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
}

/// server 对 tool 调用的响应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    /// 响应内容列表（每个元素为 JSON 值，可能是文本、图像等）。
    pub content: Vec<serde_json::Value>,
    /// 结构化输出内容（若 tool 定义了 output schema）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub structured_content: Option<serde_json::Value>,
    /// 是否表示错误响应（`true` 时调用方应将其视为失败）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_error: Option<bool>,
    /// server 自定义的 `_meta` 扩展字段。
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meta: Option<serde_json::Value>,
}

// === 适配器辅助 ===
//
// 以下类型和转换刻意放在 `codex-protocol` 中，便于其他 crate 将 "wire 形状"
// 的 MCP JSON（通常来自 rmcp 模型结构经 serde 序列化）转换为对 TS /
// JSON Schema 友好的协议类型，而无需依赖 `mcp-types`。

/// 反序列化可选整数，对超出 i64 范围的值进行有损降级（返回 `None`）。
///
/// 用于 `Resource.size` 字段：JSON 数字可能是无符号大整数或负数，本函数尽量
/// 转为 i64，失败时返回 `None` 而非报错，避免因单个字段溢出导致整个反序列化失败。
fn deserialize_lossy_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<serde_json::Number>::deserialize(deserializer)? {
        Some(number) => {
            if let Some(v) = number.as_i64() {
                Ok(Some(v))
            } else if let Some(v) = number.as_u64() {
                Ok(i64::try_from(v).ok())
            } else {
                Ok(None)
            }
        }
        None => Ok(None),
    }
}

/// `Tool` 的反序列化中间结构，兼容 camelCase 与 snake_case 字段名。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSerde {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "inputSchema", alias = "input_schema")]
    input_schema: serde_json::Value,
    #[serde(default, rename = "outputSchema", alias = "output_schema")]
    output_schema: Option<serde_json::Value>,
    #[serde(default)]
    annotations: Option<serde_json::Value>,
    #[serde(default)]
    icons: Option<Vec<serde_json::Value>>,
    #[serde(rename = "_meta", default)]
    meta: Option<serde_json::Value>,
}

impl From<ToolSerde> for Tool {
    fn from(value: ToolSerde) -> Self {
        let ToolSerde {
            name,
            title,
            description,
            input_schema,
            output_schema,
            annotations,
            icons,
            meta,
        } = value;
        Self {
            name,
            title,
            description,
            input_schema,
            output_schema,
            annotations,
            icons,
            meta,
        }
    }
}

/// `Resource` 的反序列化中间结构，兼容 camelCase 与 snake_case 字段名，
/// 并对 `size` 字段做有损 i64 降级。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSerde {
    #[serde(default)]
    annotations: Option<serde_json::Value>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "mimeType", alias = "mime_type", default)]
    mime_type: Option<String>,
    name: String,
    #[serde(default, deserialize_with = "deserialize_lossy_opt_i64")]
    size: Option<i64>,
    #[serde(default)]
    title: Option<String>,
    uri: String,
    #[serde(default)]
    icons: Option<Vec<serde_json::Value>>,
    #[serde(rename = "_meta", default)]
    meta: Option<serde_json::Value>,
}

impl From<ResourceSerde> for Resource {
    fn from(value: ResourceSerde) -> Self {
        let ResourceSerde {
            annotations,
            description,
            mime_type,
            name,
            size,
            title,
            uri,
            icons,
            meta,
        } = value;
        Self {
            annotations,
            description,
            mime_type,
            name,
            size,
            title,
            uri,
            icons,
            meta,
        }
    }
}

/// `ResourceTemplate` 的反序列化中间结构，兼容 camelCase 与 snake_case 字段名。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceTemplateSerde {
    #[serde(default)]
    annotations: Option<serde_json::Value>,
    #[serde(rename = "uriTemplate", alias = "uri_template")]
    uri_template: String,
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "mimeType", alias = "mime_type", default)]
    mime_type: Option<String>,
}

impl From<ResourceTemplateSerde> for ResourceTemplate {
    fn from(value: ResourceTemplateSerde) -> Self {
        let ResourceTemplateSerde {
            annotations,
            uri_template,
            name,
            title,
            description,
            mime_type,
        } = value;
        Self {
            annotations,
            uri_template,
            name,
            title,
            description,
            mime_type,
        }
    }
}

impl Tool {
    /// 从 MCP wire JSON 构造 [`Tool`]。
    ///
    /// 通过 [`ToolSerde`] 中间结构兼容多种字段命名风格。
    pub fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        Ok(serde_json::from_value::<ToolSerde>(value)?.into())
    }
}

impl Resource {
    /// 从 MCP wire JSON 构造 [`Resource`]。
    ///
    /// 通过 [`ResourceSerde`] 中间结构兼容多种字段命名风格，
    /// 并对 `size` 字段做有损 i64 降级。
    pub fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        Ok(serde_json::from_value::<ResourceSerde>(value)?.into())
    }
}

impl ResourceTemplate {
    /// 从 MCP wire JSON 构造 [`ResourceTemplate`]。
    ///
    /// 通过 [`ResourceTemplateSerde`] 中间结构兼容多种字段命名风格。
    pub fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        Ok(serde_json::from_value::<ResourceTemplateSerde>(value)?.into())
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn resource_size_deserializes_without_narrowing() {
        let resource = serde_json::json!({
            "name": "big",
            "uri": "file:///tmp/big",
            "size": 5_000_000_000u64,
        });

        let parsed = Resource::from_mcp_value(resource).expect("should deserialize");
        assert_eq!(parsed.size, Some(5_000_000_000));

        let resource = serde_json::json!({
            "name": "negative",
            "uri": "file:///tmp/negative",
            "size": -1,
        });

        let parsed = Resource::from_mcp_value(resource).expect("should deserialize");
        assert_eq!(parsed.size, Some(-1));

        let resource = serde_json::json!({
            "name": "too_big_for_i64",
            "uri": "file:///tmp/too_big_for_i64",
            "size": 18446744073709551615u64,
        });

        let parsed = Resource::from_mcp_value(resource).expect("should deserialize");
        assert_eq!(parsed.size, None);
    }
}
