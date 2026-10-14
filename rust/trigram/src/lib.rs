//! Text, symbol and document search over tgrep-core, in process.
//!
//! This is the one search engine behind `fs search_text` and `code search_symbol`, and the
//! one Dev links when it searches for itself: a call, not a spawn and not an MCP hop. The
//! engine is [tgrep](https://github.com/microsoft/tgrep) (MIT), the hanzoai fork, linked as
//! `tgrep-core` and pinned by exact commit. Its walker decides what is searched, as `rg`
//! does: `.gitignore`, hidden files and binary extensions are skipped, and a file past
//! [`MAX_FILE`] is not read.
//!
//! ```no_run
//! use hanzo_trigram::{search, Query};
//!
//! let hits = search(&Query::symbol("/repo", "Parser"))?;
//! for hit in &hits {
//!     println!("{}:{}: {}", hit.path.display(), hit.line, hit.excerpt);
//! }
//! # Ok::<(), hanzo_trigram::Error>(())
//! ```
//!
//! A [`Query`] is one of two kinds. [`Kind::Text`] matches a regex (or a literal with
//! `fixed`) line by line. [`Kind::Symbol`] matches an identifier on word boundaries and marks
//! each hit [`Mark::Definition`] when the line reads like a declaration of it (`fn x`,
//! `def x`, `class x`, `const x`, `func (r) x`, `x = function`, `#define x`, ...), else
//! [`Mark::Reference`]. That is textual: it finds the lines that spell the name, and it can
//! call a comment a reference.
//!
//! Hits are ranked by file, best first, then path, then line, so the same query always
//! gives the same list and a page of it is an offset into that list. A text file's score is
//! its count of matching lines; a symbol file's is its definitions times 2^32 plus its
//! references, so every file that defines the name precedes every file that only uses it.
//!
//! Documents (PDF, office files, zip, tar, gzip) are read through tgrep's adapters when the
//! query asks ([`Query::documents`]) or a path names the file. A hit inside one carries the
//! archive members it came from in [`Hit::entry`] and its place in [`Hit::place`]
//! (`page 2`, `slide 3`, `para 5`, `sheet Data!B4`), and its line counts from the start of
//! that part.
//!
//! `Query` and `Hit` carry the names and fields of Dev's `hanzo-search`, so a caller moves
//! between the two by changing an import.

mod plan;
mod read;

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use rayon::prelude::*;
use serde::Serialize;
use tgrep_core::walker;

use plan::Plan;

/// The largest file read, in bytes. A larger one is skipped, as a generated bundle or a log
/// would swamp every result and cost more to read than a search is worth.
pub const MAX_FILE: u64 = 16 << 20;

/// The most hits one file contributes, so a minified file cannot fill a list alone.
pub const PER_FILE: usize = 1000;

/// The longest excerpt, in characters.
pub const EXCERPT: usize = 500;

/// What a query looks for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A regex, or a literal with [`Query::fixed`], matched per line.
    #[default]
    Text,
    /// An identifier on word boundaries, its definitions ranked first.
    Symbol,
}

/// One search.
#[derive(Clone, Debug, Default)]
pub struct Query {
    pub kind: Kind,
    /// The regex or identifier.
    pub pattern: String,
    /// Where relative paths resolve and what hit paths are shown relative to.
    pub root: PathBuf,
    /// Files or directories to search; empty searches `root`.
    pub paths: Vec<PathBuf>,
    /// Only files whose path matches one of these are read; a glob that starts with `!`
    /// drops them instead. A glob without `/` matches the file name at any depth.
    pub glob: Vec<String>,
    /// The pattern is a literal.
    pub fixed: bool,
    pub ignore_case: bool,
    /// Lines of context on each side of a hit.
    pub context: usize,
    /// The most hits returned, best first.
    pub limit: Option<usize>,
    /// Read PDFs, office files and archives found under a directory. A document named in
    /// `paths` is read as one whatever this says.
    pub documents: bool,
}

impl Query {
    /// A regex over the files under `root`.
    pub fn text(root: impl Into<PathBuf>, pattern: impl Into<String>) -> Query {
        Query {
            kind: Kind::Text,
            pattern: pattern.into(),
            root: root.into(),
            ..Query::default()
        }
    }

    /// The textual definitions and references of an identifier under `root`.
    pub fn symbol(root: impl Into<PathBuf>, name: impl Into<String>) -> Query {
        Query {
            kind: Kind::Symbol,
            pattern: name.into(),
            root: root.into(),
            ..Query::default()
        }
    }
}

/// What a hit is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mark {
    /// A line matching a text query.
    Match,
    /// A line that reads like a declaration of the symbol.
    Definition,
    /// Any other line spelling the symbol.
    Reference,
}

impl Mark {
    pub fn label(self) -> &'static str {
        match self {
            Mark::Match => "match",
            Mark::Definition => "definition",
            Mark::Reference => "reference",
        }
    }
}

/// One result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hit {
    /// Relative to the query's root when beneath it, else absolute.
    pub path: PathBuf,
    /// Archive members from the outer file inward, joined by `!`. `None` for a plain file.
    pub entry: Option<String>,
    /// Where in a document: `page 2`, `slide 3`, `para 5`, `sheet Data!B4`. `None` for text.
    pub place: Option<String>,
    /// 1-based; within the part for a document hit.
    pub line: u64,
    /// The matching line without its terminator, cut at [`EXCERPT`] characters.
    pub excerpt: String,
    /// Up to `context` lines before the hit, in order.
    pub before: Vec<String>,
    /// Up to `context` lines after the hit, in order.
    pub after: Vec<String>,
    pub mark: Mark,
    /// The file's score; see the crate docs for the ranking.
    pub score: u64,
}

/// Why a query failed.
#[derive(Debug)]
pub enum Error {
    /// The pattern or a glob does not compile.
    Pattern(String),
    /// A path cannot be read.
    Io(PathBuf, std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Pattern(message) => write!(f, "{message}"),
            Error::Io(path, error) => write!(f, "{}: {error}", path.display()),
        }
    }
}

impl std::error::Error for Error {}

/// Runs a query. See the crate docs for kinds, ranking and documents.
pub fn search(query: &Query) -> Result<Vec<Hit>, Error> {
    if query.pattern.is_empty() {
        return Err(Error::Pattern("empty pattern".to_string()));
    }
    let plan = Plan::new(query)?;
    let root = absolute(&query.root);
    let scopes: Vec<PathBuf> = if query.paths.is_empty() {
        vec![root.clone()]
    } else {
        query
            .paths
            .iter()
            .map(|path| absolute(&root.join(path)))
            .collect()
    };
    let mut hits = Vec::new();
    for scope in scopes {
        let scope = scope
            .canonicalize()
            .map_err(|error| Error::Io(scope.clone(), error))?;
        hits.extend(scan(&plan, &scope, query.documents));
    }
    let mut seen = BTreeSet::new();
    hits.retain(|hit| seen.insert((hit.path.clone(), hit.entry.clone(), hit.place.clone(), hit.line)));
    rank(&mut hits);
    if let Some(limit) = query.limit {
        hits.truncate(limit);
    }
    let shown = root.canonicalize().unwrap_or(root);
    for hit in &mut hits {
        if let Ok(rel) = hit.path.strip_prefix(&shown) {
            hit.path = if rel.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                rel.to_path_buf()
            };
        }
    }
    Ok(hits)
}

/// Whether a file glob names a document type (`*.pdf`, `*.{docx,xlsx}`, `*.tar.gz`). A search
/// under a tree reads documents only when asked, and a glob that names one is the ask.
pub fn names_document(glob: &str) -> bool {
    let name = glob.rsplit('/').next().unwrap_or(glob);
    let Some((_, kinds)) = name.split_once('.') else {
        return false;
    };
    kinds
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|kind| !kind.is_empty())
        .any(|kind| tgrep_core::docs::handles(Path::new(&format!("x.{kind}"))))
}

/// Walks `scope` and reads what the plan admits, in path order so a result never depends on
/// which thread finished first.
fn scan(plan: &Plan, scope: &Path, documents: bool) -> Vec<Hit> {
    if scope.is_file() {
        return read::hits(plan, scope, true);
    }
    let options = walker::WalkOptions {
        max_file_size: Some(MAX_FILE),
        ..walker::WalkOptions::default()
    };
    let mut files: Vec<PathBuf> = walker::walk_dir(scope, &options)
        .files
        .into_iter()
        .filter(|path| plan.admits(&relative(scope, path)))
        .collect();
    files.sort();
    files
        .par_iter()
        .map(|path| read::hits(plan, path, documents))
        .collect::<Vec<_>>()
        .into_iter()
        .flatten()
        .collect()
}

/// Orders hits by file score, then path, then place, then line, after scoring each file.
fn rank(hits: &mut [Hit]) {
    let mut scores: BTreeMap<(PathBuf, Option<String>), u64> = BTreeMap::new();
    for hit in hits.iter() {
        let score = scores
            .entry((hit.path.clone(), hit.entry.clone()))
            .or_insert(0);
        *score += match hit.mark {
            Mark::Definition => 1 << 32,
            Mark::Match | Mark::Reference => 1,
        };
    }
    for hit in hits.iter_mut() {
        hit.score = scores
            .get(&(hit.path.clone(), hit.entry.clone()))
            .copied()
            .unwrap_or(0);
    }
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.entry.cmp(&b.entry))
            .then_with(|| a.place.cmp(&b.place))
            .then_with(|| a.line.cmp(&b.line))
    });
}

/// `path` beneath `scope`, `/`-separated.
fn relative(scope: &Path, path: &Path) -> String {
    path.strip_prefix(scope)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}
