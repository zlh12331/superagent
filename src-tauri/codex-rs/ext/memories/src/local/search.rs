//! 文件搜索模块。
//!
//! 该模块实现 memories 的 search 操作，在 memory 文件中搜索子串匹配。
//! 支持三种匹配模式：
//! - `Any`：任意查询匹配即命中
//! - `AllOnSameLine`：所有查询在同一行匹配
//! - `AllWithinLines`：所有查询在指定行数窗口内匹配

use std::borrow::Cow;
use std::path::Path;

use crate::MAX_SEARCH_RESULTS;
use crate::backend::MemoriesBackendError;
use crate::backend::MemorySearchMatch;
use crate::backend::SearchMatchMode;
use crate::backend::SearchMemoriesRequest;
use crate::backend::SearchMemoriesResponse;

use super::LocalMemoriesBackend;
use super::path::display_relative_path;
use super::path::is_hidden_path;
use super::path::read_sorted_dir_paths;
use super::path::reject_symlink;

/// 在 memory 文件中搜索子串匹配。
///
/// # 流程
/// 1. 校验查询和匹配模式
/// 2. 解析路径并校验
/// 3. 递归搜索文件
/// 4. 按路径和行号排序
/// 5. 按游标和 max_results 分页返回
///
/// # 参数
/// - `backend`：本地 memories 后端
/// - `request`：search 请求
pub(super) async fn search(
    backend: &LocalMemoriesBackend,
    request: SearchMemoriesRequest,
) -> Result<SearchMemoriesResponse, MemoriesBackendError> {
    // 预处理查询：trim 并校验非空
    let queries = request
        .queries
        .iter()
        .map(|query| query.trim().to_string())
        .collect::<Vec<_>>();
    if queries.is_empty() || queries.iter().any(std::string::String::is_empty) {
        return Err(MemoriesBackendError::EmptyQuery);
    }
    // 校验匹配窗口
    if matches!(
        request.match_mode,
        SearchMatchMode::AllWithinLines { line_count: 0 }
    ) {
        return Err(MemoriesBackendError::InvalidMatchWindow);
    }

    let max_results = request.max_results.min(MAX_SEARCH_RESULTS);
    let start = backend.resolve_scoped_path(request.path.as_deref()).await?;
    // 解析分页游标
    let start_index = match request.cursor.as_deref() {
        Some(cursor) => cursor.parse::<usize>().map_err(|_| {
            MemoriesBackendError::invalid_cursor(cursor, "must be a non-negative integer")
        })?,
        None => 0,
    };
    let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&start).await? else {
        return Err(MemoriesBackendError::NotFound {
            path: request.path.unwrap_or_default(),
        });
    };
    reject_symlink(&display_relative_path(&backend.root, &start), &metadata)?;

    let matcher = SearchMatcher::new(
        queries.clone(),
        request.match_mode.clone(),
        request.case_sensitive,
        request.normalized,
    )?;
    let mut matches = Vec::new();
    search_entries(
        &backend.root,
        &start,
        &metadata,
        &matcher,
        request.context_lines,
        &mut matches,
    )
    .await?;
    // 按路径和行号排序，保证结果稳定
    matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.match_line_number.cmp(&right.match_line_number))
    });
    if start_index > matches.len() {
        return Err(MemoriesBackendError::invalid_cursor(
            start_index.to_string(),
            "exceeds result count",
        ));
    }
    let end_index = start_index.saturating_add(max_results).min(matches.len());
    let next_cursor = (end_index < matches.len()).then(|| end_index.to_string());
    let truncated = next_cursor.is_some();
    Ok(SearchMemoriesResponse {
        queries,
        match_mode: request.match_mode,
        path: request.path,
        matches: matches.drain(start_index..end_index).collect(),
        next_cursor,
        truncated,
    })
}

/// 递归搜索目录或单文件中的匹配项。
///
/// # 参数
/// - `root`：memories 根路径（用于计算相对路径）
/// - `current`：当前搜索路径
/// - `current_metadata`：当前路径元数据
/// - `matcher`：搜索匹配器
/// - `context_lines`：上下文行数
/// - `matches`：匹配结果收集列表
async fn search_entries(
    root: &Path,
    current: &Path,
    current_metadata: &std::fs::Metadata,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<MemorySearchMatch>,
) -> Result<(), MemoriesBackendError> {
    if current_metadata.is_file() {
        search_file(root, current, matcher, context_lines, matches).await?;
        return Ok(());
    }
    if !current_metadata.is_dir() {
        return Ok(());
    }

    // 递归遍历目录（BFS）
    let mut pending = vec![current.to_path_buf()];
    while let Some(dir_path) = pending.pop() {
        for path in read_sorted_dir_paths(&dir_path).await? {
            // 跳过隐藏文件
            if is_hidden_path(&path) {
                continue;
            }
            let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&path).await? else {
                continue;
            };
            // 跳过符号链接
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                search_file(root, &path, matcher, context_lines, matches).await?;
            }
        }
    }

    Ok(())
}

/// 在单个文件中搜索匹配项。
///
/// 根据匹配模式（`Any`/`AllOnSameLine`/`AllWithinLines`）应用不同的匹配逻辑。
async fn search_file(
    root: &Path,
    path: &Path,
    matcher: &SearchMatcher,
    context_lines: usize,
    matches: &mut Vec<MemorySearchMatch>,
) -> Result<(), MemoriesBackendError> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        // 跳过非 UTF-8 文件
        Err(err) if err.kind() == std::io::ErrorKind::InvalidData => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let lines = content.lines().collect::<Vec<_>>();
    // 预计算每行匹配的查询标志
    let line_matches = lines
        .iter()
        .map(|line| matcher.matched_query_flags(line))
        .collect::<Vec<_>>();
    match &matcher.match_mode {
        SearchMatchMode::Any => {
            // 任意查询匹配即命中
            for (idx, matched_query_flags) in line_matches.iter().enumerate() {
                if matched_query_flags.iter().any(|matched| *matched) {
                    matches.push(build_search_match(
                        root,
                        path,
                        &lines,
                        idx,
                        idx,
                        context_lines,
                        matcher.matched_queries(matched_query_flags),
                    ));
                }
            }
        }
        SearchMatchMode::AllOnSameLine => {
            // 所有查询在同一行匹配
            for (idx, matched_query_flags) in line_matches.iter().enumerate() {
                if matched_query_flags.iter().all(|matched| *matched) {
                    matches.push(build_search_match(
                        root,
                        path,
                        &lines,
                        idx,
                        idx,
                        context_lines,
                        matcher.matched_queries(matched_query_flags),
                    ));
                }
            }
        }
        SearchMatchMode::AllWithinLines { line_count } => {
            // 所有查询在指定行数窗口内匹配
            let mut windows = Vec::new();
            for start_index in 0..lines.len() {
                // 窗口起始行必须至少匹配一个查询
                if !line_matches[start_index].iter().any(|matched| *matched) {
                    continue;
                }
                let last_allowed_index = start_index
                    .saturating_add(line_count.saturating_sub(1))
                    .min(lines.len().saturating_sub(1));
                let mut matched_query_flags = vec![false; matcher.queries.len()];
                for (end_index, line_match_flags) in line_matches
                    .iter()
                    .enumerate()
                    .take(last_allowed_index + 1)
                    .skip(start_index)
                {
                    // 累积窗口内的查询匹配
                    for (idx, matched) in line_match_flags.iter().enumerate() {
                        matched_query_flags[idx] |= matched;
                    }
                    if matched_query_flags.iter().all(|matched| *matched) {
                        windows.push((start_index, end_index, matched_query_flags));
                        break;
                    }
                }
            }
            // 过滤掉严格包含另一个窗口的窗口（去重）
            for (idx, (start_index, end_index, matched_query_flags)) in windows.iter().enumerate() {
                let strictly_contains_another_window = windows.iter().enumerate().any(
                    |(other_idx, (other_start_index, other_end_index, _))| {
                        idx != other_idx
                            && start_index <= other_start_index
                            && end_index >= other_end_index
                            && (start_index != other_start_index || end_index != other_end_index)
                    },
                );
                if strictly_contains_another_window {
                    continue;
                }
                matches.push(build_search_match(
                    root,
                    path,
                    &lines,
                    *start_index,
                    *end_index,
                    context_lines,
                    matcher.matched_queries(matched_query_flags),
                ));
            }
        }
    }
    Ok(())
}

/// 构建单条搜索匹配结果，包含上下文行。
///
/// # 参数
/// - `root`：memories 根路径
/// - `path`：匹配文件路径
/// - `lines`：文件所有行
/// - `match_start_index`：匹配起始行索引（0-indexed）
/// - `match_end_index`：匹配结束行索引（0-indexed）
/// - `context_lines`：上下文行数
/// - `matched_queries`：命中的查询列表
fn build_search_match(
    root: &Path,
    path: &Path,
    lines: &[&str],
    match_start_index: usize,
    match_end_index: usize,
    context_lines: usize,
    matched_queries: Vec<String>,
) -> MemorySearchMatch {
    let content_start_index = match_start_index.saturating_sub(context_lines);
    let content_end_index = match_end_index
        .saturating_add(context_lines)
        .saturating_add(1)
        .min(lines.len());
    MemorySearchMatch {
        path: display_relative_path(root, path),
        match_line_number: match_start_index + 1,
        content_start_line_number: content_start_index + 1,
        content: lines[content_start_index..content_end_index].join("\n"),
        matched_queries,
    }
}

/// 搜索匹配器，封装查询、比较策略和匹配模式。
struct SearchMatcher {
    /// 原始查询列表
    queries: Vec<String>,
    /// 预处理后的查询列表（根据比较策略转换）
    prepared_queries: Vec<String>,
    /// 比较策略
    comparison: SearchComparison,
    /// 匹配模式
    match_mode: SearchMatchMode,
}

impl SearchMatcher {
    /// 创建匹配器。
    ///
    /// # 参数
    /// - `queries`：查询列表
    /// - `match_mode`：匹配模式
    /// - `case_sensitive`：是否区分大小写
    /// - `normalized`：是否归一化（仅保留字母数字）
    fn new(
        queries: Vec<String>,
        match_mode: SearchMatchMode,
        case_sensitive: bool,
        normalized: bool,
    ) -> Result<Self, MemoriesBackendError> {
        let comparison = SearchComparison::new(case_sensitive, normalized);
        let prepared_queries = queries
            .iter()
            .map(|query| comparison.prepare(query))
            .map(Cow::into_owned)
            .collect::<Vec<_>>();
        // 归一化后可能产生空查询
        if prepared_queries.iter().any(std::string::String::is_empty) {
            return Err(MemoriesBackendError::EmptyQuery);
        }
        Ok(Self {
            queries,
            prepared_queries,
            comparison,
            match_mode,
        })
    }

    /// 返回每行中各查询的匹配标志列表。
    fn matched_query_flags(&self, line: &str) -> Vec<bool> {
        let line = self.comparison.prepare(line);
        self.prepared_queries
            .iter()
            .map(|query| line.as_ref().contains(query))
            .collect()
    }

    /// 根据匹配标志列表返回命中的查询名称。
    fn matched_queries(&self, matched_query_flags: &[bool]) -> Vec<String> {
        self.queries
            .iter()
            .zip(matched_query_flags)
            .filter_map(|(query, matched)| matched.then_some(query.clone()))
            .collect()
    }
}

/// 搜索比较策略，控制大小写和归一化行为。
#[derive(Clone, Copy)]
struct SearchComparison {
    /// 是否区分大小写
    case_sensitive: bool,
    /// 是否归一化（仅保留字母数字）
    normalized: bool,
}

impl SearchComparison {
    fn new(case_sensitive: bool, normalized: bool) -> Self {
        Self {
            case_sensitive,
            normalized,
        }
    }

    /// 根据策略预处理值。
    ///
    /// - 不区分大小写时转为小写
    /// - 归一化时仅保留字母数字字符
    fn prepare<'a>(self, value: &'a str) -> Cow<'a, str> {
        if self.case_sensitive && !self.normalized {
            return Cow::Borrowed(value);
        }

        let value = if self.case_sensitive {
            Cow::Borrowed(value)
        } else {
            Cow::Owned(value.to_lowercase())
        };
        if !self.normalized {
            return value;
        }

        Cow::Owned(
            value
                .chars()
                .filter(|ch| ch.is_alphanumeric())
                .collect::<String>(),
        )
    }
}
