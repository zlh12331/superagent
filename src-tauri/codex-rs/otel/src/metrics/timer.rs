//! Metrics 计时器（timer）。
//!
//! [`Timer`] 在创建时记录起始时间，在 drop 时自动将经过的时长
//! 作为 histogram 指标记录到关联的 [`MetricsClient`]。

use crate::metrics::MetricsClient;
use crate::metrics::error::Result;
use std::time::Instant;

/// Metrics 计时器，drop 时自动记录耗时。
#[derive(Debug)]
pub struct Timer {
    name: String,
    tags: Vec<(String, String)>,
    client: MetricsClient,
    start_time: Instant,
}

impl Drop for Timer {
    fn drop(&mut self) {
        if let Err(e) = self.record(&[]) {
            tracing::error!("metrics client error: {}", e);
        }
    }
}

impl Timer {
    /// 创建一个计时器，绑定指标名称、标签与所属的 metrics 客户端。
    pub(crate) fn new(name: &str, tags: &[(&str, &str)], client: &MetricsClient) -> Self {
        Self {
            name: name.to_string(),
            tags: tags
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            client: client.clone(),
            start_time: Instant::now(),
        }
    }

    /// 将经过的时长记录为 histogram 指标，可附加额外标签。
    pub fn record(&self, additional_tags: &[(&str, &str)]) -> Result<()> {
        let mut tags = Vec::with_capacity(self.tags.len() + additional_tags.len());
        tags.extend(additional_tags);
        tags.extend(self.tags.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        self.client
            .record_duration(&self.name, self.start_time.elapsed(), &tags)
    }
}
