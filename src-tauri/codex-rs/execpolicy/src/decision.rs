use serde::Deserialize;
use serde::Serialize;

use crate::error::Error;
use crate::error::Result;

/// 命令执行决策。
///
/// 表示策略对一条命令的最终判定：允许、需要用户审批或禁止。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// 允许命令无需进一步审批即可运行。
    Allow,
    /// 请求用户显式审批；当 `approval_policy="never"` 时直接拒绝。
    Prompt,
    /// 禁止命令运行，不再做进一步考虑。
    Forbidden,
}

impl Decision {
    /// 把字符串解析为 `Decision`。
    ///
    /// 接受的值：`"allow"`、`"prompt"`、`"forbidden"`。
    ///
    /// # Errors
    /// 当输入不是上述任一字符串时返回 `Error::InvalidDecision`。
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "allow" => Ok(Self::Allow),
            "prompt" => Ok(Self::Prompt),
            "forbidden" => Ok(Self::Forbidden),
            other => Err(Error::InvalidDecision(other.to_string())),
        }
    }
}
