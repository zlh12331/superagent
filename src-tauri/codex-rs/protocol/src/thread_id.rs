//! Thread 标识符类型。
//!
//! 定义了 [`ThreadId`]——一个基于 UUID 的 thread 标识符。Codex 生成的 thread ID
//! 使用 UUIDv7（时间有序），部分使用场景依赖该时间有序特性。该类型序列化为
//! 字符串形式以便跨进程传递。

use std::fmt::Display;

use schemars::JsonSchema;
use schemars::r#gen::SchemaGenerator;
use schemars::schema::Schema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

/// Identifier for a Codex thread.
///
/// Codex-generated thread IDs are UUIDv7, and some use cases rely on that.
///
/// Codex thread 的唯一标识符。Codex 生成的 thread ID 使用 UUIDv7（时间有序），
/// 部分使用场景依赖该特性。`pub(crate)` 字段确保外部无法直接构造任意 UUID，
/// 必须通过 `new` / `from_string` 等构造方法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, TS, Hash)]
#[ts(type = "string")]
pub struct ThreadId {
    pub(crate) uuid: Uuid,
}

impl ThreadId {
    /// 构造一个新的 `ThreadId`（使用 UUIDv7）。
    pub fn new() -> Self {
        Self {
            uuid: Uuid::now_v7(),
        }
    }

    /// 从字符串解析 `ThreadId`。
    ///
    /// # Errors
    /// 当字符串不是合法的 UUID 时返回 `uuid::Error`。
    pub fn from_string(s: &str) -> Result<Self, uuid::Error> {
        Ok(Self {
            uuid: Uuid::parse_str(s)?,
        })
    }
}

impl TryFrom<&str> for ThreadId {
    type Error = uuid::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_string(value)
    }
}

impl TryFrom<String> for ThreadId {
    type Error = uuid::Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_string(value.as_str())
    }
}

impl From<ThreadId> for String {
    fn from(value: ThreadId) -> Self {
        value.to_string()
    }
}

impl Default for ThreadId {
    fn default() -> Self {
        Self::new()
    }
}

impl Display for ThreadId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Display::fmt(&self.uuid, f)
    }
}

impl Serialize for ThreadId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_str(&self.uuid)
    }
}

impl<'de> Deserialize<'de> for ThreadId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let uuid = Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
        Ok(Self { uuid })
    }
}

impl JsonSchema for ThreadId {
    fn schema_name() -> String {
        "ThreadId".to_string()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        <String>::json_schema(generator)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_thread_id_default_is_not_zeroes() {
        let id = ThreadId::default();
        assert_ne!(id.uuid, Uuid::nil());
    }
}
