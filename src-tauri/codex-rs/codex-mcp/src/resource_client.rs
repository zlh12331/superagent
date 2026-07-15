use std::sync::Arc;
use std::sync::Weak;

use anyhow::Context;
use anyhow::Result;
use arc_swap::ArcSwap;
use codex_protocol::mcp::Resource;
use codex_protocol::mcp::ResourceContent;
use rmcp::model::PaginatedRequestParams;
use rmcp::model::ReadResourceRequestParams;

use crate::McpConnectionManager;

/// One page of resources returned by an MCP server.
#[derive(Clone, Debug, PartialEq)]
pub struct McpResourcePage {
    /// Resources advertised on this page.
    pub resources: Vec<Resource>,
    /// Opaque cursor to supply when requesting the next page.
    pub next_cursor: Option<String>,
}

/// Contents returned after reading one MCP resource.
#[derive(Clone, Debug, PartialEq)]
pub struct McpResourceReadResult {
    /// Text or blob content returned for the requested resource.
    pub contents: Vec<ResourceContent>,
}

/// 通过当前已安装的 manager 进行 Session-scoped 的 MCP resources 访问。
///
/// client 保留 manager 的 shared publication handle，而非 manager
/// snapshot，因此调用会自动使用在 startup 和 refresh 期间安装的替换。
#[derive(Clone)]
pub struct McpResourceClient {
    manager: Arc<ArcSwap<McpConnectionManager>>,
}

/// Opaque identity for the manager currently used by an MCP resource client.
#[derive(Clone)]
pub struct McpResourceClientCacheKey(Weak<McpConnectionManager>);

impl PartialEq for McpResourceClientCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.ptr_eq(&other.0)
    }
}

impl Eq for McpResourceClientCacheKey {}

impl std::fmt::Debug for McpResourceClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpResourceClient")
            .finish_non_exhaustive()
    }
}

impl McpResourceClient {
    /// Creates a resource client backed by the session's replaceable MCP manager.
    pub fn new(manager: Arc<ArcSwap<McpConnectionManager>>) -> Self {
        Self { manager }
    }

    /// Returns an identity that changes whenever the published manager changes.
    pub fn cache_key(&self) -> McpResourceClientCacheKey {
        McpResourceClientCacheKey(Arc::downgrade(&self.manager.load_full()))
    }

    /// 返回当前 manager 是否包含指定名称的 server。
    ///
    /// 此方法不会等待 server startup，也不意味着 startup 已成功。
    pub async fn has_server(&self, server: &str) -> bool {
        self.manager.load_full().contains_server(server)
    }

    /// Lists one resource page from the named server.
    pub async fn list_resources(
        &self,
        server: &str,
        cursor: Option<String>,
    ) -> Result<McpResourcePage> {
        let params =
            cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)));
        let result = self
            .manager
            .load_full()
            .list_resources(server, params)
            .await?;
        let resources = result
            .resources
            .into_iter()
            .map(resource_from_rmcp)
            .collect::<Result<Vec<_>>>()?;
        Ok(McpResourcePage {
            resources,
            next_cursor: result.next_cursor,
        })
    }

    /// Reads one resource from the named server.
    pub async fn read_resource(&self, server: &str, uri: &str) -> Result<McpResourceReadResult> {
        let result = self
            .manager
            .load_full()
            .read_resource(server, ReadResourceRequestParams::new(uri.to_string()))
            .await?;
        let contents = result
            .contents
            .into_iter()
            .map(resource_content_from_rmcp)
            .collect::<Result<Vec<_>>>()?;
        Ok(McpResourceReadResult { contents })
    }
}

fn resource_from_rmcp(resource: rmcp::model::Resource) -> Result<Resource> {
    let value = serde_json::to_value(resource).context("failed to serialize MCP resource")?;
    Resource::from_mcp_value(value).context("failed to convert MCP resource")
}

fn resource_content_from_rmcp(content: rmcp::model::ResourceContents) -> Result<ResourceContent> {
    let value =
        serde_json::to_value(content).context("failed to serialize MCP resource content")?;
    serde_json::from_value(value).context("failed to convert MCP resource content")
}
