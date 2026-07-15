//! 本模块负责将 patch 文本解析并校验为一系列 "hunk"（补丁块）。
//! （模块本身不会去检查 patch 是否能真的应用到文件系统上。）
//!
//! apply-patch 格式的官方 Lark 文法定义如下：
//!
//! start: begin_patch environment_id? hunk+ end_patch
//! begin_patch: "*** Begin Patch" LF
//! environment_id: "*** Environment ID: " filename LF
//! end_patch: "*** End Patch" LF?
//!
//! hunk: add_hunk | delete_hunk | update_hunk
//! add_hunk: "*** Add File: " filename LF add_line+
//! delete_hunk: "*** Delete File: " filename LF
//! update_hunk: "*** Update File: " filename LF change_move? change?
//! filename: /(.+)/
//! add_line: "+" /(.+)/ LF -> line
//!
//! change_move: "*** Move to: " filename LF
//! change: (change_context | change_line)+ eof_line?
//! change_context: ("@@" | "@@ " /(.+)/) LF
//! change_line: ("+" | "-" | " ") /(.+)/ LF
//! eof_line: "*** End of File" LF
//!
//! 下面的解析器比显式规范更宽松一些，允许 patch 标记前后出现空白字符。
use crate::ApplyPatchArgs;
use crate::streaming_parser::StreamingPatchParser;
#[cfg(test)]
use codex_utils_absolute_path::test_support::PathBufExt;
use codex_utils_path_uri::PathUri;
use codex_utils_path_uri::PathUriParseError;
use std::path::Path;
use std::path::PathBuf;

use thiserror::Error;

/// patch 起始标记：`*** Begin Patch`。
pub(crate) const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
/// patch 结束标记：`*** End Patch`。
pub(crate) const END_PATCH_MARKER: &str = "*** End Patch";
/// "新增文件" 块标记前缀：`*** Add File: `。
pub(crate) const ADD_FILE_MARKER: &str = "*** Add File: ";
/// "删除文件" 块标记前缀：`*** Delete File: `。
pub(crate) const DELETE_FILE_MARKER: &str = "*** Delete File: ";
/// "更新文件" 块标记前缀：`*** Update File: `。
pub(crate) const UPDATE_FILE_MARKER: &str = "*** Update File: ";
/// "移动到" 子标记前缀：`*** Move to: `。
pub(crate) const MOVE_TO_MARKER: &str = "*** Move to: ";
/// 文件末尾插入标记：`*** End of File`。
pub(crate) const EOF_MARKER: &str = "*** End of File";
/// 带上下文的 change context 标记前缀：`@@ `。
pub(crate) const CHANGE_CONTEXT_MARKER: &str = "@@ ";
/// 空上下文的 change context 标记：`@@`。
pub(crate) const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";

/// 当前已知需要宽松解析的 OpenAI 模型只有 gpt-4.1。
/// 虽然可以要求所有调用方在调用 `apply_patch` 时显式传入 strictness 参数，
/// 但要把这个参数贯穿所有调用链路非常麻烦，因此我们对所有模型统一启用宽松解析。
/// 详见 [`ParseMode::Lenient`] 中关于为 gpt-4.1 做的特殊处理说明。
const PARSE_IN_STRICT_MODE: bool = false;

/// patch 解析过程中出现的错误。
#[derive(Debug, PartialEq, Error, Clone)]
pub enum ParseError {
    /// 整体 patch 文本非法（例如缺少起始/结束标记）。
    #[error("invalid patch: {0}")]
    InvalidPatchError(String),
    /// 单个 hunk 非法，附带具体行号与错误信息。
    #[error("invalid hunk at line {line_number}, {message}")]
    InvalidHunkError { message: String, line_number: usize },
}
use ParseError::*;

/// 解析得到的一个补丁块（hunk），可以是新增文件、删除文件或更新文件。
#[derive(Debug, PartialEq, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum Hunk {
    /// 新增一个文件，`contents` 为文件完整内容。
    AddFile {
        path: PathBuf,
        contents: String,
    },
    /// 删除一个文件。
    DeleteFile {
        path: PathBuf,
    },
    /// 更新一个已存在的文件，可附带 `move_path` 表示同时重命名/移动。
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,

        /// 变更块列表，必须按文件中出现位置顺序排列：
        /// 即后一个 chunk 的 `change_context` 在文件中应出现在前一个 chunk 之后。
        chunks: Vec<UpdateFileChunk>,
    },
}

impl Hunk {
    /// 将 hunk 中的路径相对于 `cwd` 解析为绝对 [`PathUri`]。
    pub fn resolve_path(&self, cwd: &PathUri) -> Result<PathUri, PathUriParseError> {
        let path = match self {
            Hunk::UpdateFile { path, .. } => path,
            Hunk::AddFile { .. } | Hunk::DeleteFile { .. } => self.path(),
        };
        cwd.join(&path.to_string_lossy())
    }

    /// 返回本 hunk 影响到的路径；若为 rename hunk，则返回移动后的目标路径。
    pub fn path(&self) -> &Path {
        match self {
            Hunk::AddFile { path, .. } => path,
            Hunk::DeleteFile { path } => path,
            Hunk::UpdateFile {
                move_path: Some(path),
                ..
            } => path,
            Hunk::UpdateFile {
                path,
                move_path: None,
                ..
            } => path,
        }
    }
}

#[cfg(test)]
use Hunk::*;

/// 一个 "更新文件" hunk 内部的一个变更 chunk。
#[derive(Debug, PartialEq, Clone)]
pub struct UpdateFileChunk {
    /// 用于定位 chunk 位置的一行上下文（通常是类、方法或函数定义）。
    pub change_context: Option<String>,

    /// 应当被替换为 `new_lines` 的连续行块。
    /// `old_lines` 必须在 `change_context` 之后严格出现。
    pub old_lines: Vec<String>,
    /// 替换后的新内容。
    pub new_lines: Vec<String>,

    /// 若为 `true`，则要求 `old_lines` 必须出现在源文件末尾。
    /// （解析器对尾部换行符的容差是鼓励的。）
    pub is_end_of_file: bool,
}

/// 解析 patch 文本为 [`ApplyPatchArgs`]。
///
/// 解析模式由内部常量 [`PARSE_IN_STRICT_MODE`] 决定。
pub fn parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError> {
    let mode = if PARSE_IN_STRICT_MODE {
        ParseMode::Strict
    } else {
        ParseMode::Lenient
    };
    parse_patch_text(patch, mode)
}

/// 解析模式：严格（Strict）或宽松（Lenient）。
enum ParseMode {
    /// 严格按 patch 文本原样解析。
    Strict,

    /// GPT-4.1 已知会用如下形式构造 `local_shell` 工具调用的 `command` 数组：
    ///
    /// ```json
    /// [
    ///   "apply_patch",
    ///   "<<'EOF'\n*** Begin Patch\n*** Update File: README.md\n@@...\n*** End Patch\nEOF\n",
    /// ]
    /// ```
    ///
    /// 这里有个问题：`local_shell` 的名字有些误导——其 `command` 数组并不会
    /// 被传给 Bash 之类的 shell 执行，而是使用类似 `execvpe(3)` 的方式直接
    /// 调用。这意味着 shell 中 `<<'EOF'...` 的 heredoc 语义不会生效
    /// （在 shell 里 heredoc 会把内容通过 stdin 传入，而 `apply_patch` 在
    /// 没有参数时确实会从 stdin 读取），但 `execvpe(3)` 会把 heredoc 当作
    /// 字面字符串。若要让 `local_shell` 像 shell 那样工作，应该这样写：
    ///
    /// ```json
    /// [
    ///   "bash",
    ///   "-lc",
    ///   "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: README.md\n@@...\n*** End Patch\nEOF\n",
    /// ]
    /// ```
    ///
    /// 在宽松模式下：如果 `apply_patch` 的参数以 `<<'EOF'` 开头并以 `EOF\n` 结尾，
    /// 我们会去掉这两个标记，对剩余内容调用 `trim()`，然后按 patch 文本继续解析。
    Lenient,
}

fn parse_patch_text(patch: &str, mode: ParseMode) -> Result<ApplyPatchArgs, ParseError> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let patch_lines = match mode {
        ParseMode::Strict => check_patch_boundaries_strict(&lines)?,
        ParseMode::Lenient => check_patch_boundaries_lenient(&lines)?,
    };

    let patch = patch_lines.join("\n");
    let mut parser = StreamingPatchParser::default();
    parser.push_delta(&patch)?;
    let hunks = parser.finish()?;
    let environment_id = parser.environment_id().map(str::to_owned);
    Ok(ApplyPatchArgs {
        hunks,
        patch,
        workdir: None,
        environment_id,
    })
}

/// 校验 patch 文本的起始与结束行是否为 `*** Begin Patch` / `*** End Patch`。
/// 若不匹配则返回错误。
fn check_patch_boundaries_strict<'a>(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError> {
    let (first_line, last_line) = match lines {
        [] => (None, None),
        [first] => (Some(first), Some(first)),
        [first, .., last] => (Some(first), Some(last)),
    };
    check_start_and_end_lines_strict(first_line, last_line)?;
    Ok(lines)
}

/// 宽松模式下的边界校验：如果第一行以 `<<EOF`（可选引号）开头，
/// 最后一行以 `EOF` 结尾，且总行数 ≥ 4 行（heredoc 标记占 2 行，
/// patch 文本至少 2 行），则去除 heredoc 标记后递归调用严格校验。
///
/// 成功时返回去除 heredoc 标记后的 patch 内容行。
fn check_patch_boundaries_lenient<'a>(
    original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError> {
    let original_parse_error = match check_patch_boundaries_strict(original_lines) {
        Ok(lines) => return Ok(lines),
        Err(e) => e,
    };

    match original_lines {
        [first, .., last] => {
            if (first == &"<<EOF" || first == &"<<'EOF'" || first == &"<<\"EOF\"")
                && last.ends_with("EOF")
                && original_lines.len() >= 4
            {
                let inner_lines = &original_lines[1..original_lines.len() - 1];
                check_patch_boundaries_strict(inner_lines)
            } else {
                Err(original_parse_error)
            }
        }
        _ => Err(original_parse_error),
    }
}

fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError> {
    let first_line = first_line.map(|line| line.trim());
    let last_line = last_line.map(|line| line.trim());

    match (first_line, last_line) {
        (Some(first), Some(last)) if first == BEGIN_PATCH_MARKER && last == END_PATCH_MARKER => {
            Ok(())
        }
        (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(InvalidPatchError(String::from(
            "The first line of the patch must be '*** Begin Patch'",
        ))),
        _ => Err(InvalidPatchError(String::from(
            "The last line of the patch must be '*** End Patch'",
        ))),
    }
}

#[test]
fn test_parse_patch() {
    assert_eq!(
        parse_patch_text("bad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The first line of the patch must be '*** Begin Patch'".to_string()
        ))
    );
    assert_eq!(
        parse_patch_text("*** Begin Patch\nbad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );

    assert_eq!(
        parse_patch_text(
            concat!(
                "*** Begin Patch",
                " ",
                "\n*** Add File: foo\n+hi\n",
                " ",
                "*** End Patch"
            ),
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![AddFile {
            path: PathBuf::from("foo"),
            contents: "hi\n".to_string()
        }]
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: test.py\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidHunkError {
            message: "Update file hunk for path 'test.py' is empty".to_string(),
            line_number: 2,
        })
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        Vec::new()
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Add File: path/add.py\n\
             +abc\n\
             +def\n\
             *** Delete File: path/delete.py\n\
             *** Update File: path/update.py\n\
             *** Move to: path/update2.py\n\
             @@ def f():\n\
             -    pass\n\
             +    return 123\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![
            AddFile {
                path: PathBuf::from("path/add.py"),
                contents: "abc\ndef\n".to_string()
            },
            DeleteFile {
                path: PathBuf::from("path/delete.py")
            },
            UpdateFile {
                path: PathBuf::from("path/update.py"),
                move_path: Some(PathBuf::from("path/update2.py")),
                chunks: vec![UpdateFileChunk {
                    change_context: Some("def f():".to_string()),
                    old_lines: vec!["    pass".to_string()],
                    new_lines: vec!["    return 123".to_string()],
                    is_end_of_file: false
                }]
            }
        ]
    );
    // Update hunk 后紧跟另一个 hunk（Add File）。
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: file.py\n\
             @@\n\
             +line\n\
             *** Add File: other.py\n\
             +content\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![
            UpdateFile {
                path: PathBuf::from("file.py"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec![],
                    new_lines: vec!["line".to_string()],
                    is_end_of_file: false
                }],
            },
            AddFile {
                path: PathBuf::from("other.py"),
                contents: "content\n".to_string()
            }
        ]
    );

    // 第一个 chunk 没有显式 @@ header 的 Update hunk 也应能被解析。
    // 使用 raw string 以保留 context 行上的前导空格 diff 标记。
    assert_eq!(
        parse_patch_text(
            r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#,
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![UpdateFile {
            path: PathBuf::from("file2.py"),
            move_path: None,
            chunks: vec![UpdateFileChunk {
                change_context: None,
                old_lines: vec!["import foo".to_string()],
                new_lines: vec!["import foo".to_string(), "bar".to_string()],
                is_end_of_file: false,
            }],
        }]
    );
}

#[test]
fn test_parse_patch_preserves_end_of_file_marker() {
    let patch =
        "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch";
    assert_eq!(
        parse_patch(patch),
        Ok(ApplyPatchArgs {
            hunks: vec![UpdateFile {
                path: PathBuf::from("file.txt"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: Vec::new(),
                    new_lines: vec!["quux".to_string()],
                    is_end_of_file: true,
                }],
            }],
            patch: patch.to_string(),
            workdir: None,
            environment_id: None,
        })
    );
}

#[test]
fn test_parse_patch_accepts_relative_and_absolute_hunk_paths() {
    let dir = tempfile::tempdir().unwrap();
    let absolute_delete = dir.path().join("absolute-delete.py").abs();
    let absolute_update = dir.path().join("absolute-update.py").abs();
    let patch_text = format!(
        r#"*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: {}
*** Update File: {}
@@
-old
+new
*** End Patch"#,
        absolute_delete.display(),
        absolute_update.display()
    );

    assert_eq!(
        parse_patch_text(&patch_text, ParseMode::Strict)
            .unwrap()
            .hunks,
        vec![
            AddFile {
                path: PathBuf::from("relative-add.py"),
                contents: "content\n".to_string()
            },
            DeleteFile {
                path: absolute_delete.to_path_buf()
            },
            UpdateFile {
                path: absolute_update.to_path_buf(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec!["old".to_string()],
                    new_lines: vec!["new".to_string()],
                    is_end_of_file: false
                }]
            },
        ]
    );
}

#[test]
fn test_hunk_resolve_path_accepts_relative_and_absolute_paths() {
    let cwd_dir = tempfile::tempdir().unwrap();
    let cwd = PathUri::from_host_native_path(cwd_dir.path()).unwrap();
    let absolute_dir = tempfile::tempdir().unwrap();
    let absolute_add = absolute_dir.path().join("absolute-add.py").abs();
    let absolute_delete = absolute_dir.path().join("absolute-delete.py").abs();
    let absolute_update = absolute_dir.path().join("absolute-update.py").abs();

    for (hunk, expected_path) in [
        (
            AddFile {
                path: PathBuf::from("relative-add.py"),
                contents: String::new(),
            },
            cwd.join("relative-add.py").unwrap(),
        ),
        (
            DeleteFile {
                path: PathBuf::from("relative-delete.py"),
            },
            cwd.join("relative-delete.py").unwrap(),
        ),
        (
            UpdateFile {
                path: PathBuf::from("relative-update.py"),
                move_path: None,
                chunks: Vec::new(),
            },
            cwd.join("relative-update.py").unwrap(),
        ),
        (
            AddFile {
                path: absolute_add.to_path_buf(),
                contents: String::new(),
            },
            PathUri::from_abs_path(&absolute_add),
        ),
        (
            DeleteFile {
                path: absolute_delete.to_path_buf(),
            },
            PathUri::from_abs_path(&absolute_delete),
        ),
        (
            UpdateFile {
                path: absolute_update.to_path_buf(),
                move_path: None,
                chunks: Vec::new(),
            },
            PathUri::from_abs_path(&absolute_update),
        ),
    ] {
        assert_eq!(hunk.resolve_path(&cwd), Ok(expected_path));
    }
}

#[test]
fn test_parse_patch_lenient() {
    let patch_text = r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#;
    let expected_patch = vec![UpdateFile {
        path: PathBuf::from("file2.py"),
        move_path: None,
        chunks: vec![UpdateFileChunk {
            change_context: None,
            old_lines: vec!["import foo".to_string()],
            new_lines: vec!["import foo".to_string(), "bar".to_string()],
            is_end_of_file: false,
        }],
    }];
    let expected_error =
        InvalidPatchError("The first line of the patch must be '*** Begin Patch'".to_string());

    let patch_text_in_heredoc = format!("<<EOF\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch.clone(),
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_single_quoted_heredoc = format!("<<'EOF'\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_single_quoted_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_single_quoted_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch.clone(),
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_double_quoted_heredoc = format!("<<\"EOF\"\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_double_quoted_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_double_quoted_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch,
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_mismatched_quotes_heredoc = format!("<<\"EOF'\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Lenient),
        Err(expected_error.clone())
    );

    let patch_text_with_missing_closing_heredoc =
        "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n".to_string();
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Strict),
        Err(expected_error)
    );
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Lenient),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );
}

#[test]
fn test_parse_patch_environment_id_preamble() {
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID: remote\n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Ok(ApplyPatchArgs {
            hunks: vec![AddFile {
                path: PathBuf::from("hello.txt"),
                contents: "hello\n".to_string(),
            }],
            patch: "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch".to_string(),
            workdir: None,
            environment_id: Some("remote".to_string()),
        })
    );

    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID:   \n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidPatchError(
            "apply_patch environment_id cannot be empty".to_string()
        ))
    );
}
