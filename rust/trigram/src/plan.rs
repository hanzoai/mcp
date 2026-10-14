//! A query compiled once, then run over text.

use globset::Glob;
use globset::GlobSet;
use globset::GlobSetBuilder;
use regex::Regex;
use regex::RegexBuilder;

use crate::Error;
use crate::Hit;
use crate::Kind;
use crate::Mark;
use crate::Query;
use crate::EXCERPT;
use crate::PER_FILE;

/// Declaration keywords that put the declared name right after them.
const DECLARE: &str = "fn|def|class|struct|enum|union|trait|interface|type|mod|module|namespace|\
                       const|static|let|var|val|function|typedef|macro_rules!";

pub(crate) struct Plan {
    line: Regex,
    /// Present for a symbol query: the lines that declare the name.
    declare: Option<Regex>,
    keep: Option<GlobSet>,
    drop: Option<GlobSet>,
    context: usize,
}

impl Plan {
    pub fn new(query: &Query) -> Result<Plan, Error> {
        let pattern = match query.kind {
            Kind::Text if query.fixed => regex::escape(&query.pattern),
            Kind::Text => query.pattern.clone(),
            Kind::Symbol => format!(r"\b{}\b", regex::escape(&query.pattern)),
        };
        let compile = |pattern: &str| {
            RegexBuilder::new(pattern)
                .case_insensitive(query.ignore_case)
                .multi_line(true)
                .crlf(true)
                .build()
                .map_err(|error| Error::Pattern(error.to_string()))
        };
        let line = compile(&pattern)?;
        let declare = match query.kind {
            Kind::Text => None,
            Kind::Symbol => {
                let name = regex::escape(&query.pattern);
                Some(compile(&format!(
                    r"\b(?:{DECLARE})\s+(?:mut\s+)?{name}\b|\bfunc\s+(?:\([^)]*\)\s*)?{name}\b|^\s*#\s*define\s+{name}\b|\b{name}\s*[:=]\s*(?:function\b|async\b|lambda\b|\([^)]*\)\s*=>)"
                ))?)
            }
        };
        let set = |globs: Vec<&str>| -> Result<Option<GlobSet>, Error> {
            if globs.is_empty() {
                return Ok(None);
            }
            let mut set = GlobSetBuilder::new();
            for glob in globs {
                let glob = if glob.contains('/') {
                    Glob::new(glob)
                } else {
                    Glob::new(&format!("**/{glob}"))
                }
                .map_err(|error| Error::Pattern(error.to_string()))?;
                set.add(glob);
            }
            set.build()
                .map(Some)
                .map_err(|error| Error::Pattern(error.to_string()))
        };
        let keep = set(query
            .glob
            .iter()
            .filter(|glob| !glob.starts_with('!'))
            .map(String::as_str)
            .collect())?;
        let drop = set(query
            .glob
            .iter()
            .filter_map(|glob| glob.strip_prefix('!'))
            .collect())?;
        Ok(Plan {
            line,
            declare,
            keep,
            drop,
            context: query.context,
        })
    }

    /// Whether the file at `rel` (relative to the searched directory) is read.
    pub fn admits(&self, rel: &str) -> bool {
        self.keep.as_ref().is_none_or(|set| set.is_match(rel))
            && !self.drop.as_ref().is_some_and(|set| set.is_match(rel))
    }

    /// The hits in one text, at most [`PER_FILE`]. A line is a hit when the regex matches
    /// within it: a pattern that could cross a line break does not.
    pub fn lines(&self, text: &str) -> Vec<Hit> {
        let mut found: Vec<(usize, usize)> = Vec::new();
        let mut at = 0;
        while at <= text.len() && found.len() < PER_FILE {
            let Some(hit) = self.line.find_at(text, at) else {
                break;
            };
            // The empty line after a final terminator is not a line.
            if hit.start() == text.len() && (text.is_empty() || text.ends_with('\n')) {
                break;
            }
            let start = text[..hit.start()].rfind('\n').map_or(0, |i| i + 1);
            let end = text[hit.start()..]
                .find('\n')
                .map_or(text.len(), |i| hit.start() + i);
            let line = strip(&text[start..end]);
            if self.line.is_match(line) {
                found.push((start, end));
            }
            if end >= text.len() {
                break;
            }
            at = end + 1;
        }
        if found.is_empty() {
            return Vec::new();
        }
        let lines: Vec<&str> = if self.context > 0 {
            text.split('\n').map(strip).collect()
        } else {
            Vec::new()
        };
        let mut number = 1u64;
        let mut counted = 0;
        found
            .into_iter()
            .map(|(start, end)| {
                number += memchr::memchr_iter(b'\n', &text.as_bytes()[counted..start]).count() as u64;
                counted = start;
                let excerpt = strip(&text[start..end]);
                let mark = match &self.declare {
                    None => Mark::Match,
                    Some(declare) if declare.is_match(excerpt) => Mark::Definition,
                    Some(_) => Mark::Reference,
                };
                let index = (number - 1) as usize;
                let (before, after) = if self.context > 0 {
                    let first = index.saturating_sub(self.context);
                    let last = (index + 1 + self.context).min(lines.len());
                    (
                        lines[first..index].iter().map(|l| cut(l)).collect(),
                        lines[(index + 1).min(last)..last].iter().map(|l| cut(l)).collect(),
                    )
                } else {
                    (Vec::new(), Vec::new())
                };
                Hit {
                    path: std::path::PathBuf::new(),
                    entry: None,
                    place: None,
                    line: number,
                    excerpt: cut(excerpt),
                    before,
                    after,
                    mark,
                    score: 0,
                }
            })
            .collect()
    }
}

fn strip(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// A line cut at [`EXCERPT`] characters.
fn cut(line: &str) -> String {
    match line.char_indices().nth(EXCERPT) {
        Some((end, _)) => line[..end].to_string(),
        None => line.to_string(),
    }
}
