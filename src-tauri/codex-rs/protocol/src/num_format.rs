//! 数字格式化工具。
//!
//! 提供基于 locale 的整数分隔符格式化（如 en-US 下 `12345` → `12,345`），
//! 以及 token 计数的 SI 后缀格式化（如 `123456789` → `123M`）。格式化器在
//! 首次使用时按系统 locale 初始化，失败时回退到 en-US。

use std::sync::OnceLock;

use icu_decimal::DecimalFormatter;
use icu_decimal::input::Decimal;
use icu_decimal::options::DecimalFormatterOptions;
use icu_locale_core::Locale;

/// 根据系统 locale 构造格式化器；若失败则返回 `None`。
fn make_local_formatter() -> Option<DecimalFormatter> {
    let loc: Locale = sys_locale::get_locale()?.parse().ok()?;
    DecimalFormatter::try_new(loc.into(), DecimalFormatterOptions::default()).ok()
}

/// 构造 en-US 兜底格式化器。
fn make_en_us_formatter() -> DecimalFormatter {
    #![allow(clippy::expect_used)]
    let loc: Locale = "en-US".parse().expect("en-US wasn't a valid locale");
    DecimalFormatter::try_new(loc.into(), DecimalFormatterOptions::default())
        .expect("en-US wasn't a valid locale")
}

/// 返回进程级单例格式化器（优先系统 locale，失败回退 en-US）。
fn formatter() -> &'static DecimalFormatter {
    static FORMATTER: OnceLock<DecimalFormatter> = OnceLock::new();
    FORMATTER.get_or_init(|| make_local_formatter().unwrap_or_else(make_en_us_formatter))
}

/// Format an i64 with locale-aware digit separators (e.g. "12345" -> "12,345"
/// for en-US).
///
/// 以 locale 感知的分隔符格式化 `i64`（如 en-US 下 `12345` → `12,345`）。
pub fn format_with_separators(n: i64) -> String {
    formatter().format(&Decimal::from(n)).to_string()
}

/// 使用指定格式化器进行分隔符格式化（内部辅助函数）。
fn format_with_separators_with_formatter(n: i64, formatter: &DecimalFormatter) -> String {
    formatter.format(&Decimal::from(n)).to_string()
}

fn format_si_suffix_with_formatter(n: i64, formatter: &DecimalFormatter) -> String {
    let n = n.max(0);
    if n < 1000 {
        return formatter.format(&Decimal::from(n)).to_string();
    }

    // Format `n / scale` with the requested number of fractional digits.
    // 以指定小数位格式化 `n / scale`。
    let format_scaled = |n: i64, scale: i64, frac_digits: u32| -> String {
        let value = n as f64 / scale as f64;
        let scaled: i64 = (value * 10f64.powi(frac_digits as i32)).round() as i64;
        let mut dec = Decimal::from(scaled);
        dec.multiply_pow10(-(frac_digits as i16));
        formatter.format(&dec).to_string()
    };

    const UNITS: [(i64, &str); 3] = [(1_000, "K"), (1_000_000, "M"), (1_000_000_000, "G")];
    let f = n as f64;
    for &(scale, suffix) in &UNITS {
        if (100.0 * f / scale as f64).round() < 1000.0 {
            return format!("{}{}", format_scaled(n, scale, 2), suffix);
        } else if (10.0 * f / scale as f64).round() < 1000.0 {
            return format!("{}{}", format_scaled(n, scale, 1), suffix);
        } else if (f / scale as f64).round() < 1000.0 {
            return format!("{}{}", format_scaled(n, scale, 0), suffix);
        }
    }

    // Above 1000G, keep whole‑G precision.
    // 超过 1000G 时保留整 G 精度。
    format!(
        "{}G",
        format_with_separators_with_formatter(((n as f64) / 1e9).round() as i64, formatter)
    )
}

/// Format token counts to 3 significant figures, using base-10 SI suffixes.
///
/// Examples (en-US):
///   - 999 -> "999"
///   - 1200 -> "1.20K"
///   - 123456789 -> "123M"
///
/// 将 token 计数格式化为 3 位有效数字并附加 base-10 SI 后缀。
pub fn format_si_suffix(n: i64) -> String {
    format_si_suffix_with_formatter(n, formatter())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kmg() {
        let formatter = make_en_us_formatter();
        let fmt = |n: i64| format_si_suffix_with_formatter(n, &formatter);
        assert_eq!(fmt(0), "0");
        assert_eq!(fmt(999), "999");
        assert_eq!(fmt(1_000), "1.00K");
        assert_eq!(fmt(1_200), "1.20K");
        assert_eq!(fmt(10_000), "10.0K");
        assert_eq!(fmt(100_000), "100K");
        assert_eq!(fmt(999_500), "1.00M");
        assert_eq!(fmt(1_000_000), "1.00M");
        assert_eq!(fmt(1_234_000), "1.23M");
        assert_eq!(fmt(12_345_678), "12.3M");
        assert_eq!(fmt(999_950_000), "1.00G");
        assert_eq!(fmt(1_000_000_000), "1.00G");
        assert_eq!(fmt(1_234_000_000), "1.23G");
        // Above 1000G we keep whole‑G precision (no higher unit supported here).
        assert_eq!(fmt(1_234_000_000_000), "1,234G");
    }
}
