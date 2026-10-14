//! Add a line to a section of a markdown file.

use crate::action::*;
use crate::state::State;
use serde_json::json;

pub struct Note;

static SPEC: Spec = Spec {
    id: "note",
    version: 1,
    summary: "Add one line of text at the end of a named section of a markdown file.",
    triggers: &[
        r"add (the |a )?(line|note|sentence|entry)",
        r"\bappend\b",
        r"under (the )?.*(heading|section)",
        r"insert .* (line|note)",
        r"at the end of the .* section",
    ],
    inputs: &[
        Input {
            name: "path",
            ask: "Which document does the request mean?",
            kind: Kind::Pick(Source::Docs),
            optional: false,
        },
        Input {
            name: "heading",
            ask: "Which section does the request mean?",
            kind: Kind::Pick(Source::Headings),
            optional: false,
        },
        Input {
            name: "text",
            ask: "",
            kind: Kind::Literal(
                r#"(?i)\b(?:line|text|note|sentence|entry)\s+[`"\u{201c}]([^`"\u{201d}]+)[`"\u{201d}]"#,
            ),
            optional: false,
        },
    ],
    effect: Effect::Write,
    tools: &[],
    pure: false,
};

/// `(level, title)` of a heading line.
pub fn heading(line: &str) -> Option<(usize, String)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    (1..=6)
        .contains(&level)
        .then_some(())
        .and(line[level..].strip_prefix(' '))
        .map(|t| (level, t.trim().to_string()))
}

/// Where the line goes: after the last non-blank line of the section `title`.
fn place(lines: &[String], title: &str) -> Option<usize> {
    let mut found = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| heading(l).is_some_and(|(_, t)| t == title));
    let (at, line) = found.next()?;
    if found.next().is_some() {
        return None;
    }
    let level = heading(line)?.0;
    let end = lines[at + 1..]
        .iter()
        .position(|l| heading(l).is_some_and(|(n, _)| n <= level))
        .map_or(lines.len(), |p| at + 1 + p);
    let last = (at..end)
        .rev()
        .find(|i| !lines[*i].trim().is_empty())
        .unwrap_or(at);
    Some(last + 1)
}

impl Action for Note {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn check(&self, state: &State, args: &Args) -> Vec<Check> {
        let path = text(args, "path").unwrap_or("");
        let body = std::fs::read_to_string(state.root.join(path)).unwrap_or_default();
        let lines: Vec<String> = body.lines().map(str::to_string).collect();
        let line = text(args, "text").unwrap_or("");
        vec![
            Check::new("document", state.root.join(path).is_file(), path),
            Check::new(
                "section is unique",
                place(&lines, text(args, "heading").unwrap_or("")).is_some(),
                text(args, "heading").unwrap_or(""),
            ),
            Check::new(
                "line is new",
                !line.is_empty() && !lines.iter().any(|l| l == line),
                line,
            ),
        ]
    }

    fn reads(&self, _state: &State, args: &Args) -> Reads {
        Reads::Files(
            text(args, "path")
                .map(|p| vec![p.to_string()])
                .unwrap_or_default(),
        )
    }

    fn run(&self, cx: &mut Cx, args: &Args) -> Result<Output, String> {
        let (path, title, line) = (
            text(args, "path").ok_or("no document")?,
            text(args, "heading").ok_or("no section")?,
            text(args, "text").ok_or("no text")?,
        );
        let target = cx.path(path);
        let body = std::fs::read_to_string(&target).map_err(|e| format!("{path}: {e}"))?;
        let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
        let at = place(&lines, title).ok_or("the section is not unique")?;
        lines.insert(at, line.to_string());
        let mut out = lines.join("\n");
        if body.ends_with('\n') {
            out.push('\n');
        }
        std::fs::write(&target, out).map_err(|e| format!("{path}: {e}"))?;
        Ok(Output {
            text: format!("added a line under {title} in {path}"),
            data: json!({ "path": path, "line": at + 1 }),
        })
    }

    fn verify(&self, cx: &Cx, args: &Args, out: &Output) -> Verdict {
        let (Some(path), Some(line), Some(title)) = (
            text(args, "path"),
            text(args, "text"),
            text(args, "heading"),
        ) else {
            return Verdict::fail("no note");
        };
        let now: Vec<String> = std::fs::read_to_string(cx.path(path))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect();
        let at = out.data["line"].as_u64().unwrap_or(0) as usize;
        let section = now
            .iter()
            .position(|l| heading(l).is_some_and(|(_, t)| t == title));
        match (now.get(at.wrapping_sub(1)), section) {
            (Some(l), Some(s)) if l == line && at > s + 1 => Verdict::pass(format!("{path}:{at}")),
            _ => Verdict::fail("the line is not under its heading"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    #[test]
    fn the_line_goes_after_the_last_line_of_its_section() {
        let doc = l("# T\n\n## Notes\n\n- a\n- b\n\n## Other\n\nx");
        assert_eq!(place(&doc, "Notes"), Some(6));
        assert_eq!(place(&doc, "Other"), Some(10));
        assert_eq!(place(&doc, "Missing"), None);
    }

    #[test]
    fn an_empty_section_takes_it_under_the_heading() {
        assert_eq!(place(&l("## A\n\n## B"), "A"), Some(1));
    }
}
