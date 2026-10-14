//! Reading a file for a plan: plain text, or a document through tgrep's adapters.

use std::path::Path;

use tgrep_core::docs;
use tgrep_core::docs::Loc;
use tgrep_core::docs::Unit;
use tgrep_core::encoding::EncodingMode;

use crate::plan::Plan;
use crate::Hit;

/// The hits in the file at `path`, each carrying that path. `documents` says whether a
/// document found by a walk is read; a file the caller named is read as what it is.
pub(crate) fn hits(plan: &Plan, path: &Path, documents: bool) -> Vec<Hit> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    if docs::handles(path) {
        if !documents {
            return Vec::new();
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Ok(doc) = docs::extract(&name, &bytes) else {
            return Vec::new();
        };
        return doc
            .parts
            .iter()
            .flat_map(|part| {
                let mut found = plan.lines(doc.part_text(part));
                for hit in &mut found {
                    hit.path = path.to_path_buf();
                    hit.entry = entry(&part.loc);
                    hit.place = place(&part.loc);
                }
                found
            })
            .collect();
    }
    let (text, _) = tgrep_core::encoding::decode_owned_with_fixups(bytes, EncodingMode::Auto);
    if text.as_bytes().contains(&0) {
        return Vec::new();
    }
    let mut found = plan.lines(&text);
    for hit in &mut found {
        hit.path = path.to_path_buf();
    }
    found
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
