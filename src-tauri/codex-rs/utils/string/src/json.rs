//! JSON serialization helpers for output that must remain parseable as JSON
//! while staying safe for ASCII-only transports.

use std::io;

use serde::Serialize;

struct AsciiJsonFormatter;

impl serde_json::ser::Formatter for AsciiJsonFormatter {
    // serde_json has no ensure_ascii flag; this formatter keeps its serializer
    // in charge and only escapes non-ASCII string fragments.
    fn write_string_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
    where
        W: ?Sized + io::Write,
    {
        let mut start = 0;
        for (index, ch) in fragment.char_indices() {
            if ch.is_ascii() {
                continue;
            }

            if start < index {
                writer.write_all(&fragment.as_bytes()[start..index])?;
            }

            let mut utf16 = [0; 2];
            for code_unit in ch.encode_utf16(&mut utf16) {
                write!(writer, "\\u{code_unit:04x}")?;
            }
            start = index + ch.len_utf8();
        }

        if start < fragment.len() {
            writer.write_all(&fragment.as_bytes()[start..])?;
        }

        Ok(())
    }
}

/// 序列化 JSON 时将非 ASCII 字符串内容转义为 `\uXXXX` 形式。
///
/// 当 JSON 需要保持可解析为 JSON 的同时，又必须经过仅支持 ASCII 安全传输的
/// 通道（例如 HTTP headers）传递时，该函数非常有用。通过将所有非 ASCII
/// 字符转义为 `\uXXXX` 序列，可以避免在受限传输层中出现编码问题。
pub fn to_ascii_json_string<T>(value: &T) -> serde_json::Result<String>
where
    T: Serialize + ?Sized,
{
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, AsciiJsonFormatter);
    value.serialize(&mut serializer)?;
    String::from_utf8(bytes)
        .map_err(|err| serde_json::Error::io(io::Error::new(io::ErrorKind::InvalidData, err)))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use pretty_assertions::assert_eq;
    use serde::Serialize;
    use serde::ser::SerializeStruct;
    use serde_json::Value;
    use serde_json::json;

    use super::to_ascii_json_string;

    #[test]
    fn to_ascii_json_string_escapes_non_ascii_strings() {
        struct TestPayload;

        impl Serialize for TestPayload {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                let workspaces = BTreeMap::from([("/tmp/東京", TestWorkspace)]);
                let mut state = serializer.serialize_struct("TestPayload", 1)?;
                state.serialize_field("workspaces", &workspaces)?;
                state.end()
            }
        }

        struct TestWorkspace;

        impl Serialize for TestWorkspace {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                let mut state = serializer.serialize_struct("TestWorkspace", 2)?;
                state.serialize_field("label", "Agentlarım")?;
                state.serialize_field("emoji", "🚀")?;
                state.end()
            }
        }

        let value = TestPayload;
        let expected_value = json!({
            "workspaces": {
                "/tmp/東京": {
                    "label": "Agentlarım",
                    "emoji": "🚀"
                }
            }
        });

        let serialized = to_ascii_json_string(&value).expect("serialize ascii json");

        assert_eq!(
            serialized,
            r#"{"workspaces":{"/tmp/\u6771\u4eac":{"label":"Agentlar\u0131m","emoji":"\ud83d\ude80"}}}"#
        );
        assert!(serialized.is_ascii());
        assert!(!serialized.contains("東京"));
        assert!(!serialized.contains("Agentlarım"));
        assert!(!serialized.contains("🚀"));
        let parsed: Value = serde_json::from_str(&serialized).expect("serialized json");
        assert_eq!(parsed, expected_value);
    }
}
