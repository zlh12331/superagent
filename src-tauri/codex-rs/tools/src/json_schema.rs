use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

const DEFINITION_TABLE_KEYS: [&str; 2] = ["$defs", "definitions"];
const SCHEMA_CHILD_KEYS: [&str; 4] = ["items", "anyOf", "oneOf", "allOf"];
const COMPOSITION_SCHEMA_KEYS: [&str; 3] = ["anyOf", "oneOf", "allOf"];

/// 我们在工具定义中所支持的 JSON Schema 原始类型名称。
///
/// 该枚举对应 OpenAI Structured Outputs 中 JSON Schema `type` 字段的子集：
/// string、number、boolean、integer、object、array 与 null。
/// `enum`、`const`、`anyOf`、`oneOf`、`allOf` 等关键字在结构中单独建模。
/// 参见 <https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas>。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JsonSchemaPrimitiveType {
    String,
    Number,
    Boolean,
    Integer,
    Object,
    Array,
    Null,
}

/// JSON Schema 的 `type` 字段，可以是单个类型名，也可以是多个类型名的联合。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum JsonSchemaType {
    Single(JsonSchemaPrimitiveType),
    Multiple(Vec<JsonSchemaPrimitiveType>),
}

/// 工具定义所需的 JSON Schema 子集通用表示。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct JsonSchema {
    /// `$ref` 引用，指向 schema 内的某个定义。
    #[serde(rename = "$ref", skip_serializing_if = "Option::is_none")]
    pub schema_ref: Option<String>,
    /// schema 的类型，可以是单个或多个类型。
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub schema_type: Option<JsonSchemaType>,
    /// 字段或类型的描述文本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 仅用于 Responses API 的标记，表示该工具参数经过加密审查。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
    /// 枚举可选值列表。
    #[serde(rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<JsonValue>>,
    /// 数组类型的元素 schema。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<JsonSchema>>,
    /// 对象类型的属性 schema 映射。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, JsonSchema>>,
    /// 对象类型中必填的属性名列表。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
    /// 对 `additionalProperties` 的约束，可以是布尔开关或一个 schema。
    #[serde(
        rename = "additionalProperties",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional_properties: Option<AdditionalProperties>,
    /// `anyOf` 组合关键字。
    #[serde(rename = "anyOf", skip_serializing_if = "Option::is_none")]
    pub any_of: Option<Vec<JsonSchema>>,
    /// `oneOf` 组合关键字。
    #[serde(rename = "oneOf", skip_serializing_if = "Option::is_none")]
    pub one_of: Option<Vec<JsonSchema>>,
    /// `allOf` 组合关键字。
    #[serde(rename = "allOf", skip_serializing_if = "Option::is_none")]
    pub all_of: Option<Vec<JsonSchema>>,
    /// `$defs` 定义表。
    #[serde(rename = "$defs", skip_serializing_if = "Option::is_none")]
    pub defs: Option<BTreeMap<String, JsonSchema>>,
    /// `definitions` 定义表（旧版 JSON Schema 用法）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definitions: Option<BTreeMap<String, JsonSchema>>,
}

impl JsonSchema {
    /// 构造一个具有单个 JSON Schema 类型的标量/对象/数组 schema。
    fn typed(schema_type: JsonSchemaPrimitiveType, description: Option<String>) -> Self {
        Self {
            schema_type: Some(JsonSchemaType::Single(schema_type)),
            description,
            ..Default::default()
        }
    }

    /// 构造一个 `anyOf` 组合 schema。
    pub fn any_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self {
        Self {
            description,
            any_of: Some(variants),
            ..Default::default()
        }
    }

    /// 构造一个 `oneOf` 组合 schema。
    pub fn one_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self {
        Self {
            description,
            one_of: Some(variants),
            ..Default::default()
        }
    }

    /// 构造一个 `allOf` 组合 schema。
    pub fn all_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self {
        Self {
            description,
            all_of: Some(variants),
            ..Default::default()
        }
    }

    /// 构造一个 `boolean` 类型 schema。
    pub fn boolean(description: Option<String>) -> Self {
        Self::typed(JsonSchemaPrimitiveType::Boolean, description)
    }

    /// 构造一个 `string` 类型 schema。
    pub fn string(description: Option<String>) -> Self {
        Self::typed(JsonSchemaPrimitiveType::String, description)
    }

    /// 标记当前 schema 为加密参数，返回修改后的 schema。
    pub fn with_encrypted(mut self) -> Self {
        self.encrypted = Some(true);
        self
    }

    /// 构造一个 `number` 类型 schema。
    pub fn number(description: Option<String>) -> Self {
        Self::typed(JsonSchemaPrimitiveType::Number, description)
    }

    /// 构造一个 `integer` 类型 schema。
    pub fn integer(description: Option<String>) -> Self {
        Self::typed(JsonSchemaPrimitiveType::Integer, description)
    }

    /// 构造一个 `null` 类型 schema。
    pub fn null(description: Option<String>) -> Self {
        Self::typed(JsonSchemaPrimitiveType::Null, description)
    }

    /// 构造一个字符串枚举 schema，限定取值范围。
    pub fn string_enum(values: Vec<JsonValue>, description: Option<String>) -> Self {
        Self {
            schema_type: Some(JsonSchemaType::Single(JsonSchemaPrimitiveType::String)),
            description,
            enum_values: Some(values),
            ..Default::default()
        }
    }

    /// 构造一个数组 schema，指定元素 schema。
    pub fn array(items: JsonSchema, description: Option<String>) -> Self {
        Self {
            schema_type: Some(JsonSchemaType::Single(JsonSchemaPrimitiveType::Array)),
            description,
            items: Some(Box::new(items)),
            ..Default::default()
        }
    }

    /// 构造一个对象 schema，指定属性、必填字段及 `additionalProperties` 约束。
    pub fn object(
        properties: BTreeMap<String, JsonSchema>,
        required: Option<Vec<String>>,
        additional_properties: Option<AdditionalProperties>,
    ) -> Self {
        Self {
            schema_type: Some(JsonSchemaType::Single(JsonSchemaPrimitiveType::Object)),
            properties: Some(properties),
            required,
            additional_properties,
            ..Default::default()
        }
    }
}

/// 表示 `additionalProperties` 的取值，可以是布尔开关或一个 schema。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum AdditionalProperties {
    Boolean(bool),
    Schema(Box<JsonSchema>),
}

impl From<bool> for AdditionalProperties {
    fn from(value: bool) -> Self {
        Self::Boolean(value)
    }
}

impl From<JsonSchema> for AdditionalProperties {
    fn from(value: JsonSchema) -> Self {
        Self::Schema(Box::new(value))
    }
}

/// 解析工具的 `input_schema`，若 schema 无效则返回错误。
///
/// 该函数会先对 schema 进行清洗与剪枝，再对过大的 schema 进行压缩，最后反序列化为 [`JsonSchema`]。
///
/// # 参数
/// - `input_schema`: 原始输入 schema 的 JSON 值
///
/// # 返回值
/// 返回解析后的 [`JsonSchema`]；若 schema 无效则返回 [`serde_json::Error`]。
pub fn parse_tool_input_schema(input_schema: &JsonValue) -> Result<JsonSchema, serde_json::Error> {
    let mut input_schema = prepare_tool_input_schema(input_schema);
    compact_large_tool_schema(&mut input_schema);
    deserialize_tool_input_schema(input_schema)
}

/// 解析受信任的工具 `input_schema`，跳过大 schema 压缩步骤。
///
/// 适用于来源可信、无需压缩的场景，仅做 schema 清洗与剪枝后反序列化。
///
/// # 参数
/// - `input_schema`: 原始输入 schema 的 JSON 值
///
/// # 返回值
/// 返回解析后的 [`JsonSchema`]；若 schema 无效则返回 [`serde_json::Error`]。
pub fn parse_tool_input_schema_without_compaction(
    input_schema: &JsonValue,
) -> Result<JsonSchema, serde_json::Error> {
    deserialize_tool_input_schema(prepare_tool_input_schema(input_schema))
}

fn prepare_tool_input_schema(input_schema: &JsonValue) -> JsonValue {
    let mut input_schema = input_schema.clone();
    sanitize_json_schema(&mut input_schema);
    prune_unreachable_definitions(&mut input_schema);
    input_schema
}

fn deserialize_tool_input_schema(input_schema: JsonValue) -> Result<JsonSchema, serde_json::Error> {
    let schema: JsonSchema = serde_json::from_value(input_schema)?;
    if matches!(
        schema.schema_type,
        Some(JsonSchemaType::Single(JsonSchemaPrimitiveType::Null))
    ) {
        return Err(singleton_null_schema_error());
    }
    Ok(schema)
}

// 使用紧凑归一化后的 JSON 字节数作为 1k token schema 预算的低成本本地代理。
const MAX_COMPACT_TOOL_SCHEMA_BYTES: usize = 4_000;
const MAX_COMPACT_TOOL_SCHEMA_DEPTH: usize = 3;

/// 在保留顶层参数表面的前提下，压缩异常庞大的工具 schema。
/// 压缩是尽力而为而非硬性上限：仅在 schema 清洗/剪枝完成后执行，
/// 并在 schema 仍超出预算时按递增的有损策略逐轮应用。
fn compact_large_tool_schema(value: &mut JsonValue) {
    for pass in LARGE_SCHEMA_COMPACTION_PASSES {
        if compact_schema_fits_budget(value) {
            break;
        }
        pass(value);
    }
}

type LargeSchemaCompactionPass = fn(&mut JsonValue);

const LARGE_SCHEMA_COMPACTION_PASSES: &[LargeSchemaCompactionPass] = &[
    strip_schema_descriptions,
    drop_schema_definitions,
    collapse_deep_schema_objects_from_root,
    prune_schema_compositions,
];

fn collapse_deep_schema_objects_from_root(value: &mut JsonValue) {
    collapse_deep_schema_objects(value, /*depth*/ 0);
}

fn compact_schema_fits_budget(value: &JsonValue) -> bool {
    compact_normalized_schema_len(value) <= MAX_COMPACT_TOOL_SCHEMA_BYTES
}

fn compact_normalized_schema_len(value: &JsonValue) -> usize {
    serde_json::from_value::<JsonSchema>(value.clone())
        .and_then(|schema| serde_json::to_vec(&schema))
        .map(|json| json.len())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefinitionTraversal {
    Include,
    Skip,
}

fn for_each_schema_child(
    map: &serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&JsonValue),
) {
    if let Some(properties) = map.get("properties")
        && let Some(properties_map) = properties.as_object()
    {
        for value in properties_map.values() {
            visitor(value);
        }
    }

    for key in SCHEMA_CHILD_KEYS {
        if let Some(value) = map.get(key) {
            visitor(value);
        }
    }

    if let Some(additional_properties) = map.get("additionalProperties")
        && !matches!(additional_properties, JsonValue::Bool(_))
    {
        visitor(additional_properties);
    }

    if definition_traversal == DefinitionTraversal::Include {
        for key in DEFINITION_TABLE_KEYS {
            if let Some(definitions) = map.get(key)
                && let Some(definitions_map) = definitions.as_object()
            {
                for value in definitions_map.values() {
                    visitor(value);
                }
            }
        }
    }
}

fn strip_schema_descriptions(value: &mut JsonValue) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                strip_schema_descriptions(value);
            }
        }
        JsonValue::Object(map) => {
            map.remove("description");
            for_each_schema_child_mut(map, DefinitionTraversal::Include, &mut |value| {
                strip_schema_descriptions(value);
            });
        }
        _ => {}
    }
}

fn for_each_schema_child_mut(
    map: &mut serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&mut JsonValue),
) {
    if let Some(properties) = map.get_mut("properties")
        && let Some(properties_map) = properties.as_object_mut()
    {
        for value in properties_map.values_mut() {
            visitor(value);
        }
    }

    for key in SCHEMA_CHILD_KEYS {
        if let Some(value) = map.get_mut(key) {
            visitor(value);
        }
    }

    if let Some(additional_properties) = map.get_mut("additionalProperties")
        && !matches!(additional_properties, JsonValue::Bool(_))
    {
        visitor(additional_properties);
    }

    if definition_traversal == DefinitionTraversal::Include {
        for key in DEFINITION_TABLE_KEYS {
            if let Some(definitions) = map.get_mut(key)
                && let Some(definitions_map) = definitions.as_object_mut()
            {
                for value in definitions_map.values_mut() {
                    visitor(value);
                }
            }
        }
    }
}

/// 在删除根定义表之前，将本地定义引用替换为空 schema，
/// 从而避免下游行为依赖于 schema 解析器对缺失定义引用的处理方式。
fn drop_schema_definitions(value: &mut JsonValue) {
    rewrite_definition_refs_to_empty_schemas(value);

    let JsonValue::Object(map) = value else {
        return;
    };

    for key in DEFINITION_TABLE_KEYS {
        map.remove(key);
    }
}

fn rewrite_definition_refs_to_empty_schemas(value: &mut JsonValue) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                rewrite_definition_refs_to_empty_schemas(value);
            }
        }
        JsonValue::Object(map) => {
            if map
                .get("$ref")
                .and_then(JsonValue::as_str)
                .and_then(parse_local_definition_ref)
                .is_some()
            {
                *value = json!({});
                return;
            }

            for_each_schema_child_mut(map, DefinitionTraversal::Skip, &mut |value| {
                rewrite_definition_refs_to_empty_schemas(value);
            });
        }
        _ => {}
    }
}

fn collapse_deep_schema_objects(value: &mut JsonValue, depth: usize) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                collapse_deep_schema_objects(value, depth);
            }
        }
        JsonValue::Object(map) => {
            if depth >= MAX_COMPACT_TOOL_SCHEMA_DEPTH && is_complex_schema_object(map) {
                *value = json!({});
                return;
            }

            for_each_schema_child_mut(map, DefinitionTraversal::Skip, &mut |value| {
                collapse_deep_schema_objects(value, depth + 1);
            });
        }
        _ => {}
    }
}

fn prune_schema_compositions(value: &mut JsonValue) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                prune_schema_compositions(value);
            }
        }
        JsonValue::Object(map) => {
            if has_composition_keyword(map) {
                *value = json!({});
                return;
            }

            for_each_schema_child_mut(map, DefinitionTraversal::Skip, &mut |value| {
                prune_schema_compositions(value);
            });
        }
        _ => {}
    }
}

fn is_complex_schema_object(map: &serde_json::Map<String, JsonValue>) -> bool {
    SCHEMA_CHILD_KEYS.iter().any(|key| map.contains_key(*key))
        || map.contains_key("properties")
        || map.contains_key("additionalProperties")
        || map.contains_key("$ref")
}

fn has_composition_keyword(map: &serde_json::Map<String, JsonValue>) -> bool {
    COMPOSITION_SCHEMA_KEYS
        .into_iter()
        .any(|key| map.contains_key(key))
}

/// 对 JSON Schema（以 `serde_json::Value` 形式表示）进行清洗，使其适配我们受限的 schema 表示。
/// 该函数会执行以下操作：
/// - 确保每个有类型的 schema 对象在需要时具有 `"type"` 字段。
/// - 保留显式的 `anyOf`、`oneOf`、`allOf`。
/// - 保留 `$ref` 以及可达的本地 `$defs` / `definitions`。
/// - 将 `const` 折叠为单值 `enum`。
/// - 为 object/array 类型 schema（包括可空联合）补充缺失的子字段，使用宽松默认值。
/// - 将没有可识别 schema 提示的对象 schema 转换为 `{}`。
fn sanitize_json_schema(value: &mut JsonValue) {
    match value {
        JsonValue::Bool(_) => {
            // JSON Schema 布尔形式：true/false，统一转换为接受任意字符串的 schema。
            *value = json!({ "type": "string" });
        }
        JsonValue::Array(values) => {
            for value in values {
                sanitize_json_schema(value);
            }
        }
        JsonValue::Object(map) => {
            if let Some(properties) = map.get_mut("properties")
                && let Some(properties_map) = properties.as_object_mut()
            {
                for value in properties_map.values_mut() {
                    sanitize_json_schema(value);
                }
            }
            if let Some(items) = map.get_mut("items") {
                sanitize_json_schema(items);
            }
            if let Some(additional_properties) = map.get_mut("additionalProperties")
                && !matches!(additional_properties, JsonValue::Bool(_))
            {
                sanitize_json_schema(additional_properties);
            }
            if let Some(value) = map.get_mut("prefixItems") {
                sanitize_json_schema(value);
            }
            for key in COMPOSITION_SCHEMA_KEYS {
                if let Some(value) = map.get_mut(key) {
                    sanitize_json_schema(value);
                }
            }
            for table in DEFINITION_TABLE_KEYS {
                sanitize_schema_table(map, table);
            }

            if let Some(const_value) = map.remove("const") {
                map.insert("enum".to_string(), JsonValue::Array(vec![const_value]));
            }

            let mut schema_types = normalized_schema_types(map);

            if schema_types.is_empty() && (map.contains_key("$ref") || has_composition_keyword(map))
            {
                return;
            }

            if schema_types.is_empty() {
                if map.contains_key("properties")
                    || map.contains_key("required")
                    || map.contains_key("additionalProperties")
                {
                    schema_types.push(JsonSchemaPrimitiveType::Object);
                } else if map.contains_key("items") || map.contains_key("prefixItems") {
                    schema_types.push(JsonSchemaPrimitiveType::Array);
                } else if map.contains_key("enum") || map.contains_key("format") {
                    schema_types.push(JsonSchemaPrimitiveType::String);
                } else if map.contains_key("minimum")
                    || map.contains_key("maximum")
                    || map.contains_key("exclusiveMinimum")
                    || map.contains_key("exclusiveMaximum")
                    || map.contains_key("multipleOf")
                {
                    schema_types.push(JsonSchemaPrimitiveType::Number);
                } else {
                    map.clear();
                    return;
                }
            }

            write_schema_types(map, &schema_types);
            ensure_default_children_for_schema_types(map, &schema_types);
        }
        _ => {}
    }
}

/// 在反序列化为 `JsonSchema` 之前清洗 schema 定义表。
///
/// 定义表必须是对象。Codex 保留有效的定义表并递归应用与内联 schema 相同的兼容性降级，
/// 但会丢弃格式错误的定义表，使 `strict: false` 工具注册可以优雅降级，
/// 而不是因为不可达或无效的定义表而失败。
fn sanitize_schema_table(map: &mut serde_json::Map<String, JsonValue>, key: &str) {
    let should_remove = match map.get_mut(key) {
        Some(JsonValue::Object(definitions)) => {
            for definition in definitions.values_mut() {
                sanitize_json_schema(definition);
            }
            false
        }
        Some(_) => true,
        None => false,
    };

    if should_remove {
        map.remove(key);
    }
}

fn ensure_default_children_for_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
) {
    if schema_types.contains(&JsonSchemaPrimitiveType::Object) && !map.contains_key("properties") {
        map.insert(
            "properties".to_string(),
            JsonValue::Object(serde_json::Map::new()),
        );
    }

    if schema_types.contains(&JsonSchemaPrimitiveType::Array) && !map.contains_key("items") {
        map.insert("items".to_string(), json!({ "type": "string" }));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DefinitionPointer {
    table: &'static str,
    name: String,
}

/// 剪枝未被引用的根定义条目，避免为工具 schema 中从未引用的定义浪费 token。
fn prune_unreachable_definitions(value: &mut JsonValue) {
    let reachable = collect_reachable_definitions(value);
    let JsonValue::Object(map) = value else {
        return;
    };

    for table in DEFINITION_TABLE_KEYS {
        prune_schema_table(map, table, &reachable);
    }
}

fn prune_schema_table(
    map: &mut serde_json::Map<String, JsonValue>,
    table: &'static str,
    reachable: &BTreeSet<DefinitionPointer>,
) {
    let Some(JsonValue::Object(definitions)) = map.get_mut(table) else {
        return;
    };

    definitions.retain(|name, _| {
        reachable.contains(&DefinitionPointer {
            table,
            name: name.clone(),
        })
    });

    if definitions.is_empty() {
        map.remove(table);
    }
}

fn collect_reachable_definitions(value: &JsonValue) -> BTreeSet<DefinitionPointer> {
    let mut reachable = BTreeSet::new();
    let mut pending = Vec::new();

    collect_refs_outside_definitions(value, &mut pending);

    while let Some(pointer) = pending.pop() {
        if !reachable.insert(pointer.clone()) {
            continue;
        }

        if let Some(definition) = definition_for_pointer(value, &pointer) {
            collect_refs(definition, &mut pending);
        }
    }

    reachable
}

fn collect_refs_outside_definitions(value: &JsonValue, refs: &mut Vec<DefinitionPointer>) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                collect_refs_outside_definitions(value, refs);
            }
        }
        JsonValue::Object(map) => {
            collect_ref_from_map(map, refs);
            for_each_schema_child(map, DefinitionTraversal::Skip, &mut |value| {
                collect_refs_outside_definitions(value, refs);
            });
        }
        _ => {}
    }
}

fn collect_refs(value: &JsonValue, refs: &mut Vec<DefinitionPointer>) {
    match value {
        JsonValue::Array(values) => {
            for value in values {
                collect_refs(value, refs);
            }
        }
        JsonValue::Object(map) => {
            collect_ref_from_map(map, refs);
            for value in map.values() {
                collect_refs(value, refs);
            }
        }
        _ => {}
    }
}

fn collect_ref_from_map(
    map: &serde_json::Map<String, JsonValue>,
    refs: &mut Vec<DefinitionPointer>,
) {
    if let Some(JsonValue::String(schema_ref)) = map.get("$ref")
        && let Some(pointer) = parse_local_definition_ref(schema_ref)
    {
        refs.push(pointer);
    }
}

fn definition_for_pointer<'a>(
    value: &'a JsonValue,
    pointer: &DefinitionPointer,
) -> Option<&'a JsonValue> {
    let JsonValue::Object(map) = value else {
        return None;
    };

    map.get(pointer.table)
        .and_then(JsonValue::as_object)
        .and_then(|definitions| definitions.get(&pointer.name))
}

fn parse_local_definition_ref(schema_ref: &str) -> Option<DefinitionPointer> {
    let fragment = schema_ref.strip_prefix('#')?;
    let pointer = urlencoding::decode(fragment).ok()?;
    let pointer = jsonptr::Pointer::parse(pointer.as_ref()).ok()?;

    let (table_token, pointer) = pointer.split_front()?;
    let table = table_token.decoded();
    let table = DEFINITION_TABLE_KEYS
        .into_iter()
        .find(|candidate| table.as_ref() == *candidate)?;

    // Responses API non-strict 模式接受嵌套的本地引用，例如
    // `#/$defs/User/properties/name`，因此保留父定义可达。
    let (name, _) = pointer.split_front()?;
    Some(DefinitionPointer {
        table,
        name: name.decoded().into_owned(),
    })
}

fn normalized_schema_types(
    map: &serde_json::Map<String, JsonValue>,
) -> Vec<JsonSchemaPrimitiveType> {
    let Some(schema_type) = map.get("type") else {
        return Vec::new();
    };

    match schema_type {
        JsonValue::String(schema_type) => schema_type_from_str(schema_type).into_iter().collect(),
        JsonValue::Array(schema_types) => schema_types
            .iter()
            .filter_map(JsonValue::as_str)
            .filter_map(schema_type_from_str)
            .collect(),
        _ => Vec::new(),
    }
}

fn write_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
) {
    match schema_types {
        [] => {
            map.remove("type");
        }
        [schema_type] => {
            map.insert(
                "type".to_string(),
                JsonValue::String(schema_type_name(*schema_type).to_string()),
            );
        }
        _ => {
            map.insert(
                "type".to_string(),
                JsonValue::Array(
                    schema_types
                        .iter()
                        .map(|schema_type| {
                            JsonValue::String(schema_type_name(*schema_type).to_string())
                        })
                        .collect(),
                ),
            );
        }
    }
}

fn schema_type_from_str(schema_type: &str) -> Option<JsonSchemaPrimitiveType> {
    match schema_type {
        "string" => Some(JsonSchemaPrimitiveType::String),
        "number" => Some(JsonSchemaPrimitiveType::Number),
        "boolean" => Some(JsonSchemaPrimitiveType::Boolean),
        "integer" => Some(JsonSchemaPrimitiveType::Integer),
        "object" => Some(JsonSchemaPrimitiveType::Object),
        "array" => Some(JsonSchemaPrimitiveType::Array),
        "null" => Some(JsonSchemaPrimitiveType::Null),
        _ => None,
    }
}

fn schema_type_name(schema_type: JsonSchemaPrimitiveType) -> &'static str {
    match schema_type {
        JsonSchemaPrimitiveType::String => "string",
        JsonSchemaPrimitiveType::Number => "number",
        JsonSchemaPrimitiveType::Boolean => "boolean",
        JsonSchemaPrimitiveType::Integer => "integer",
        JsonSchemaPrimitiveType::Object => "object",
        JsonSchemaPrimitiveType::Array => "array",
        JsonSchemaPrimitiveType::Null => "null",
    }
}

fn singleton_null_schema_error() -> serde_json::Error {
    serde_json::Error::io(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "tool input schema must not be a singleton null type",
    ))
}

#[cfg(test)]
#[path = "json_schema_tests.rs"]
mod tests;
