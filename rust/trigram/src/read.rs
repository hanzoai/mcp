//! Reading a file for a plan: plain text, or a document through tgrep's adapters.

use std::collections::BTreeMap;
use std::path::Path;

use tgrep_core::docs;
use tgrep_core::docs::Loc;
use tgrep_core::docs::Unit;
use tgrep_core::encoding::EncodingMode;

use crate::plan::Plan;
use crate::Hit;

/// Calls `visit(entry, place, text)` for each searchable part of the file at `path`: the file's
/// text, or each page, slide, paragraph, cell or archive member of a document. `documents` says
/// whether a document found by a walk is read; a file the caller named is read as what it is.
fn parts(path: &Path, documents: bool, mut visit: impl FnMut(Option<String>, Option<String>, &str)) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if docs::handles(path) {
        if !documents {
            return;
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Ok(doc) = docs::extract(&name, &bytes) else {
            return;
        };
        for part in &doc.parts {
            visit(entry(&part.loc), place(&part.loc), doc.part_text(part));
        }
        return;
    }
    let (text, _) = tgrep_core::encoding::decode_owned_with_fixups(bytes, EncodingMode::Auto);
    if !text.as_bytes().contains(&0) {
        visit(None, None, &text);
    }
}

/// The hits in the file at `path`, each carrying that path.
pub(crate) fn hits(plan: &Plan, path: &Path, documents: bool) -> Vec<Hit> {
    let mut found = Vec::new();
    parts(path, documents, |entry, place, text| {
        for mut hit in plan.lines(text) {
            hit.path = path.to_path_buf();
            hit.entry = entry.clone();
            hit.place = place.clone();
            found.push(hit);
        }
    });
    found
}

/// What the file at `path` weighs in the ranking, by archive entry (a plain file has one,
/// `None`). Nothing is allocated per match, so a pattern that hits a million lines costs
/// counting them and not holding them.
pub(crate) fn scores(plan: &Plan, path: &Path, documents: bool) -> Vec<(Option<String>, u64)> {
    let mut by_entry: BTreeMap<Option<String>, u64> = BTreeMap::new();
    parts(path, documents, |entry, _, text| {
        let score = plan.score(text);
        if score > 0 {
            *by_entry.entry(entry).or_insert(0) += score;
        }
    });
    by_entry.into_iter().collect()
}

/// The archive members a part came from, outermost first.
fn entry(loc: &Loc) -> Option<String> {
    (!loc.members.is_empty()).then(|| loc.members.join("!"))
}

/// Where in the document a part is.
fn place(loc: &Loc) -> Option<String> {
    Some(match loc.unit.as_ref()? {
        Unit::Page(n) => format!("page {n}"),
        Unit::Slide(n) => format!("slide {n}"),
        Unit::Para(n) => format!("para {n}"),
        Unit::Cell { sheet, cell } => format!("sheet {sheet}!{cell}"),
        _ => return None,
    })
}
