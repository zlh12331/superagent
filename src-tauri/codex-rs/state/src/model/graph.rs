use strum::AsRefStr;
use strum::Display;
use strum::EnumString;

/// 方向性 thread-spawn 边的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, AsRefStr, Display, EnumString)]
#[strum(serialize_all = "snake_case")]
pub enum DirectionalThreadSpawnEdgeStatus {
    Open,
    Closed,
}
