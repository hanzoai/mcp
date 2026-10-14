//! tgrep's on-disk index: found, built, and asked for the files a pattern can be in.
//!
//! An index answers which files can hold a match; the matching is still done on each file's
//! current bytes, so a hit is never stale. What an index cannot know is what changed after it was
//! built, so every file whose content or name changed at or after the build is read from disk
//! whether the index lists it or not, and a listed file that no longer exists is dropped. The
//! result is the one a scan gives, with the scan's cost replaced by the index's.

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use tgrep_core::builder;
use tgrep_core::docs;
use tgrep_core::meta;
use tgrep_core::meta::IndexMeta;
use tgrep_core::path_index;
use tgrep_core::query;
use tgrep_core::reader::IndexReader;
use tgrep_core::walker;

use crate::plan::Plan;
use crate::relative;
use crate::Error;

/// The nearest directory at or above `path` that holds a tgrep index.
pub fn locate(path: &Path) -> Option<PathBuf> {
    let start = if path.is_file() { path.parent()? } else { path };
    start
        .ancestors()
        .find(|dir| builder::default_index_dir(dir).join("meta.json").is_file())
        .map(Path::to_path_buf)
}

/// What an index holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub root: PathBuf,
    pub files: u64,
    /// When it was last written.
    pub built: SystemTime,
    /// Complete and of this tgrep's format, so it can answer.
    pub usable: bool,
}

/// The state of the index at or above `path`, if there is one.
pub fn status(path: &Path) -> Option<Status> {
    let root = locate(path)?;
    let meta = IndexMeta::load(&builder::default_index_dir(&root)).ok()?;
    Some(Status {
        root,
        files: meta.num_files,
        built: UNIX_EPOCH + Duration::from_secs(meta.updated_at),
        usable: usable(&meta),
    })
}

/// Builds the index for `root` into `root/.tgrep`, as `tgrep index` does, holding tgrep's
/// writer lock. Fails when a tgrep server or another build owns it.
pub fn build(root: &Path) -> Result<Status, Error> {
    let root = root
        .canonicalize()
        .map_err(|error| Error::Io(root.to_path_buf(), error))?;
    let fail = |message: String| Error::Build(root.clone(), message);
    let dir = builder::default_index_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|error| fail(error.to_string()))?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("serve.lock"))
        .map_err(|error| fail(error.to_string()))?;
    lock.try_lock()
        .map_err(|_| fail("an index server or build owns this index".to_string()))?;
    builder::build_index_with_options(&root, Some(&dir), &builder::BuildOptions::default())
        .map_err(|error| fail(error.to_string()))?;
    status(&root).ok_or_else(|| fail("the index was not written".to_string()))
}

fn usable(meta: &IndexMeta) -> bool {
    meta.complete && meta.hidden_complete && meta.version == meta::INDEX_FORMAT_VERSION
}

/// The files under `scope` the plan has to read, from the index at or above it, or `None` when
/// no usable index covers `scope` (the caller scans). `documents` keeps document files in the
/// answer, as a scan would.
pub(crate) fn files(plan: &Plan, scope: &Path, documents: bool) -> Option<Result<Vec<PathBuf>, Error>> {
    let root = locate(scope)?;
    let dir = builder::default_index_dir(&root);
    let meta = IndexMeta::load(&dir).ok().filter(usable)?;
    let reader = IndexReader::open(&dir).ok()?;
    let names = path_index::read_filename_index(&dir).ok()??;
    let visibility = names.visibility?;
    if !visibility.covers_index(&meta, reader.file_table_id()) {
        return None;
    }
    let prefix = match relative(&root, scope) {
        rel if rel.is_empty() => String::new(),
        rel => format!("{rel}/"),
    };
    let trigrams = match query::build_query_plan(plan.pattern(), plan.ignore_case()) {
        Ok(trigrams) => trigrams,
        Err(error) => return Some(Err(Error::Pattern(error))),
    };
    let ids = if trigrams.is_match_all() {
        reader.all_file_ids()
    } else {
        query::execute_plan_with_masks(&trigrams, &|trigram| reader.lookup_trigram_with_masks(trigram))
    };

    // What changed since the index was written is read from disk: a walk of names and metadata.
    let built = UNIX_EPOCH + Duration::from_secs(meta.updated_at);
    let dirty = changed(scope, built);
    let stale: BTreeSet<String> = dirty.iter().map(|path| relative(&root, path)).collect();

    let mut files: BTreeSet<PathBuf> = ids
        .iter()
        .filter_map(|&id| reader.file_path(id))
        // A document's parts are indexed under the file's path and a location.
        .map(|path| docs::split(path).0)
        .filter(|path| {
            path.starts_with(&prefix)
                && visibility.paths.is_visible(path, &prefix, false)
                && !stale.contains(*path)
                && plan.admits(&path[prefix.len()..])
        })
        .map(|path| root.join(path))
        .filter(|path| documents || !docs::handles(path))
        .collect();
    files.extend(
        dirty
            .into_iter()
            .filter(|path| path.is_file() && !walker::is_binary_extension(path))
            .filter(|path| plan.admits(&relative(scope, path)))
            .filter(|path| documents || !docs::handles(path)),
    );
    Some(Ok(files.into_iter().collect()))
}

/// The files under `scope` whose content or name changed at or after `since`, no larger than a
/// scan would read.
fn changed(scope: &Path, since: SystemTime) -> BTreeSet<PathBuf> {
    walker::walk_dir(scope, &walker::WalkOptions::default())
        .listed_files
        .par_iter()
        .filter(|path| {
            std::fs::symlink_metadata(path)
                .is_ok_and(|metadata| touched(&metadata) >= since && metadata.len() <= crate::MAX_FILE)
        })
        .cloned()
        .collect()
}

/// The later of a file's content change and its status change: a rename moves the second.
fn touched(metadata: &std::fs::Metadata) -> SystemTime {
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let status = UNIX_EPOCH
            + Duration::new(
                u64::try_from(metadata.ctime()).unwrap_or(0),
                u32::try_from(metadata.ctime_nsec()).unwrap_or(0),
            );
        modified.max(status)
    }
    #[cfg(not(unix))]
    {
        modified
    }
}
