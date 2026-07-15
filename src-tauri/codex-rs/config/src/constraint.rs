//! 配置约束系统核心。
//!
//! 定义 [`Constrained<T>`] 包装类型——一个带验证器与可选规范化器的受约束
//! 值。所有 `set` 操作在写入前必须通过验证器；若设置了规范化器，则先
//! 规范化再验证。这为 config layer 系统提供了"值必须满足 requirements"
//! 的统一抽象。
//!
//! 典型用法：每个配置字段持有 `Constrained<T>`，由 requirements layer
//! 通过 `add_validator` 叠加约束、`allow_only` 锁定值，运行时通过 `set`
//! 更新。`ConstraintError` 描述校验失败的具体原因与来源 layer。

use std::fmt;
use std::sync::Arc;

use crate::config_requirements::RequirementSource;
use thiserror::Error;

/// 约束校验失败错误。
///
/// 每个变体携带足够的上下文信息（字段名、候选值、来源 layer 等），
/// 便于上层生成面向用户的诊断信息。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConstraintError {
    /// 候选值不在允许集合内。
    ///
    /// 字段：
    /// - `field_name`: 字段名（静态字符串）
    /// - `candidate`: 被拒绝的候选值（字符串化）
    /// - `allowed`: 允许集合的人类可读描述
    /// - `requirement_source`: 施加该约束的来源 layer
    #[error(
        "invalid value for `{field_name}`: `{candidate}` is not in the allowed set {allowed} (set by {requirement_source})"
    )]
    InvalidValue {
        field_name: &'static str,
        candidate: String,
        allowed: String,
        requirement_source: RequirementSource,
    },

    /// 必填字段为空。
    #[error("field `{field_name}` cannot be empty")]
    EmptyField { field_name: String },

    /// requirements 中的 exec policy 规则解析失败。
    #[error("invalid rules in requirements (set by {requirement_source}): {reason}")]
    ExecPolicyParse {
        requirement_source: RequirementSource,
        reason: String,
    },

    /// 某个 MCP server 的 requirement 解析失败。
    #[error(
        "invalid requirement for MCP server `{server_name}` (set by {requirement_source}): {reason}"
    )]
    McpServerRequirementParse {
        server_name: String,
        requirement_source: RequirementSource,
        reason: String,
    },
}

impl ConstraintError {
    /// 构造一个 `EmptyField` 错误的便捷方法。
    pub fn empty_field(field_name: impl Into<String>) -> Self {
        Self::EmptyField {
            field_name: field_name.into(),
        }
    }
}

/// 约束校验结果类型别名。
pub type ConstraintResult<T> = Result<T, ConstraintError>;

impl From<ConstraintError> for std::io::Error {
    fn from(err: ConstraintError) -> Self {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, err)
    }
}

/// 验证器函数类型：接收候选值的引用，返回校验结果。
type ConstraintValidator<T> = dyn Fn(&T) -> ConstraintResult<()> + Send + Sync;
/// 规范化器函数类型：将一个值转换为同类型的另一个值。
///
/// [`Constrained`] 用规范化器在写入前变换值以满足约束或强制特定形态
/// （例如把负数 clamp 到 0）。
type ConstraintNormalizer<T> = dyn Fn(T) -> T + Send + Sync;

/// 受约束的值包装类型。
///
/// 内部持有当前值、验证器 `Arc` 与可选规范化器 `Arc`。验证器与规范化器
/// 通过 `Arc` 共享，因此 `Constrained` 可低成本克隆（`Clone` 派生）。
///
/// 不变量：
/// - 当前值始终满足当前验证器（`new` / `set` / `add_validator` 都会校验）
/// - 若存在规范化器，`set` 时会先规范化再校验
#[derive(Clone)]
pub struct Constrained<T> {
    value: T,
    validator: Arc<ConstraintValidator<T>>,
    normalizer: Option<Arc<ConstraintNormalizer<T>>>,
}

impl<T: Send + Sync> Constrained<T> {
    /// 用初始值与验证器构造 `Constrained`。
    ///
    /// 初始值必须通过验证器，否则返回 `ConstraintError`。无规范化器。
    ///
    /// # Errors
    /// 若 `initial_value` 不满足 `validator`，返回对应的 `ConstraintError`。
    pub fn new(
        initial_value: T,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<Self> {
        let validator: Arc<ConstraintValidator<T>> = Arc::new(validator);
        validator(&initial_value)?;
        Ok(Self {
            value: initial_value,
            validator,
            normalizer: None,
        })
    }

    /// 用规范化器构造一个允许任意值的 `Constrained`。
    ///
    /// 初始值会先经规范化器变换，再由"允许任意值"的验证器校验（恒通过）。
    /// 后续 `set` 也会先规范化再校验。
    pub fn normalized(
        initial_value: T,
        normalizer: impl Fn(T) -> T + Send + Sync + 'static,
    ) -> ConstraintResult<Self> {
        let validator: Arc<ConstraintValidator<T>> = Arc::new(|_| Ok(()));
        let normalizer: Arc<ConstraintNormalizer<T>> = Arc::new(normalizer);
        let normalized = normalizer(initial_value);
        validator(&normalized)?;
        Ok(Self {
            value: normalized,
            validator,
            normalizer: Some(normalizer),
        })
    }

    /// 构造一个允许任意值的 `Constrained`，使用给定初始值。
    ///
    /// 无规范化器；验证器恒通过。适用于无 requirements 约束的字段。
    pub fn allow_any(initial_value: T) -> Self {
        Self {
            value: initial_value,
            validator: Arc::new(|_| Ok(())),
            normalizer: None,
        }
    }

    /// 构造一个仅允许单一值的 `Constrained`。
    ///
    /// 验证器拒绝任何不等于 `only_value` 的候选值。适用于被 requirements
    /// 锁定的字段。`T` 需满足 `Clone + Debug + PartialEq`。
    pub fn allow_only(only_value: T) -> Self
    where
        T: Clone + fmt::Debug + PartialEq + 'static,
    {
        let allowed_value = only_value.clone();
        Self {
            value: only_value,
            validator: Arc::new(move |candidate| {
                if candidate == &allowed_value {
                    Ok(())
                } else {
                    Err(ConstraintError::InvalidValue {
                        field_name: "<unknown>",
                        candidate: format!("{candidate:?}"),
                        allowed: format!("[{allowed_value:?}]"),
                        requirement_source: RequirementSource::Unknown,
                    })
                }
            }),
            normalizer: None,
        }
    }

    /// 构造一个允许任意值的 `Constrained`，初始值取 `T::default()`。
    pub fn allow_any_from_default() -> Self
    where
        T: Default,
    {
        Self::allow_any(T::default())
    }

    /// 返回当前值的引用。
    pub fn get(&self) -> &T {
        &self.value
    }

    /// 返回当前值的拷贝（要求 `T: Copy`）。
    pub fn value(&self) -> T
    where
        T: Copy,
    {
        self.value
    }

    /// 探测候选值是否能通过验证器，不修改当前值。
    ///
    /// # Errors
    /// 若 `candidate` 不满足验证器，返回对应的 `ConstraintError`。
    pub fn can_set(&self, candidate: &T) -> ConstraintResult<()> {
        (self.validator)(candidate)
    }

    /// 在当前约束上叠加一个新的验证器。
    ///
    /// 新验证器与原验证器组合为"先原后新"的顺序；当前值必须能通过组合后
    /// 的验证器，否则不安装并返回错误。
    ///
    /// # Errors
    /// 若当前值不满足组合后的验证器，返回 `ConstraintError` 且不修改原验证器。
    pub fn add_validator(
        &mut self,
        validator: impl Fn(&T) -> ConstraintResult<()> + Send + Sync + 'static,
    ) -> ConstraintResult<()>
    where
        T: 'static,
    {
        let existing_validator = self.validator.clone();
        let combined_validator: Arc<ConstraintValidator<T>> = Arc::new(move |candidate| {
            existing_validator(candidate)?;
            validator(candidate)
        });

        combined_validator(&self.value)?;
        self.validator = combined_validator;
        Ok(())
    }

    /// 设置新值：先规范化（若有），再校验，最后写入。
    ///
    /// # Errors
    /// 若规范化后的值不满足验证器，返回 `ConstraintError` 且不修改当前值。
    pub fn set(&mut self, value: T) -> ConstraintResult<()> {
        let value = if let Some(normalizer) = &self.normalizer {
            normalizer(value)
        } else {
            value
        };
        (self.validator)(&value)?;
        self.value = value;
        Ok(())
    }
}

impl<T> std::ops::Deref for Constrained<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl<T: fmt::Debug> fmt::Debug for Constrained<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Constrained")
            .field("value", &self.value)
            .finish()
    }
}

impl<T: PartialEq> PartialEq for Constrained<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn invalid_value(candidate: impl Into<String>, allowed: impl Into<String>) -> ConstraintError {
        ConstraintError::InvalidValue {
            field_name: "<unknown>",
            candidate: candidate.into(),
            allowed: allowed.into(),
            requirement_source: RequirementSource::Unknown,
        }
    }

    #[test]
    fn constrained_allow_any_accepts_any_value() {
        let mut constrained = Constrained::allow_any(/*initial_value*/ 5);
        constrained
            .set(/*value*/ -10)
            .expect("allow any accepts all values");
        assert_eq!(constrained.value(), -10);
    }

    #[test]
    fn constrained_allow_any_default_uses_default_value() {
        let constrained = Constrained::<i32>::allow_any_from_default();
        assert_eq!(constrained.value(), 0);
    }

    #[test]
    fn constrained_allow_only_rejects_different_values() {
        let mut constrained = Constrained::allow_only(/*only_value*/ 5);
        constrained
            .set(/*value*/ 5)
            .expect("allowed value should be accepted");

        let err = constrained
            .set(/*value*/ 6)
            .expect_err("different value should be rejected");
        assert_eq!(err, invalid_value("6", "[5]"));
        assert_eq!(constrained.value(), 5);
    }

    #[test]
    fn constrained_normalizer_applies_on_init_and_set() -> anyhow::Result<()> {
        let mut constrained =
            Constrained::normalized(/*initial_value*/ -1, |value| value.max(0))?;
        assert_eq!(constrained.value(), 0);
        constrained.set(/*value*/ -5)?;
        assert_eq!(constrained.value(), 0);
        constrained.set(/*value*/ 10)?;
        assert_eq!(constrained.value(), 10);
        Ok(())
    }

    #[test]
    fn constrained_add_validator_composes_with_existing_validator() -> anyhow::Result<()> {
        let mut constrained = Constrained::new(/*initial_value*/ 5, |value: &i32| {
            if *value >= 0 {
                Ok(())
            } else {
                Err(ConstraintError::empty_field("value"))
            }
        })?;
        constrained.add_validator(|value| {
            if *value <= 10 {
                Ok(())
            } else {
                Err(ConstraintError::empty_field("value"))
            }
        })?;

        assert_eq!(constrained.can_set(&7), Ok(()));
        assert_eq!(
            constrained.can_set(&11),
            Err(ConstraintError::empty_field("value"))
        );
        assert_eq!(
            constrained.can_set(&-1),
            Err(ConstraintError::empty_field("value"))
        );

        Ok(())
    }

    #[test]
    fn constrained_new_rejects_invalid_initial_value() {
        let result = Constrained::new(/*initial_value*/ 0, |value| {
            if *value > 0 {
                Ok(())
            } else {
                Err(invalid_value(value.to_string(), "positive values"))
            }
        });

        assert_eq!(result, Err(invalid_value("0", "positive values")));
    }

    #[test]
    fn constrained_set_rejects_invalid_value_and_leaves_previous() {
        let mut constrained = Constrained::new(/*initial_value*/ 1, |value| {
            if *value > 0 {
                Ok(())
            } else {
                Err(invalid_value(value.to_string(), "positive values"))
            }
        })
        .expect("initial value should be accepted");

        let err = constrained
            .set(/*value*/ -5)
            .expect_err("negative values should be rejected");
        assert_eq!(err, invalid_value("-5", "positive values"));
        assert_eq!(constrained.value(), 1);
    }

    #[test]
    fn constrained_can_set_allows_probe_without_setting() {
        let constrained = Constrained::new(/*initial_value*/ 1, |value| {
            if *value > 0 {
                Ok(())
            } else {
                Err(invalid_value(value.to_string(), "positive values"))
            }
        })
        .expect("initial value should be accepted");

        constrained
            .can_set(&2)
            .expect("can_set should accept positive value");
        let err = constrained
            .can_set(&-1)
            .expect_err("can_set should reject negative value");
        assert_eq!(err, invalid_value("-1", "positive values"));
        assert_eq!(constrained.value(), 1);
    }
}
