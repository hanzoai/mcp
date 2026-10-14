//! Reading a request against values: where a value is mentioned, and whether a description of it
//! is grounded in the request.

const STOP: &[&str] = &[
    "the", "and", "for", "that", "this", "with", "from", "into", "onto", "then", "than", "them",
    "its", "are", "was", "were", "has", "have", "had", "not", "but", "all", "any", "one", "two",
    "out", "off", "per", "via", "use", "used", "using", "make", "made", "get", "got", "new", "old",
    "add", "run", "file", "files", "line", "lines", "when", "what", "which", "who", "how", "where",
    "whose", "also", "only", "just", "each", "every", "some", "more", "most", "less", "into",
    "over", "under", "about", "after", "before", "should", "would", "could", "please", "show",
    "tell", "give",
];

/// Lowercase words of at least three letters or digits, without the filler words, each once.
pub fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if c.is_alphanumeric() {
            word.extend(c.to_lowercase());
        } else {
            if word.chars().count() >= 3 && !STOP.contains(&word.as_str()) && !out.contains(&word) {
                out.push(std::mem::take(&mut word));
            }
            word.clear();
        }
    }
    out
}

fn boundary(c: Option<char>) -> bool {
    c.is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '.' | '/' | '-')))
}

/// Byte offset of the first place `needle` stands alone in `text` (not inside a longer name).
pub fn mention(text: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        // A sentence's full stop after the name is not part of it.
        let after_ok =
            boundary(after) || (after == Some('.') && boundary(text[end + 1..].chars().next()));
        if boundary(before) && after_ok {
            return Some(start);
        }
        from = start + needle.len().max(1);
    }
    None
}

/// Whether the words of `label` that the request also uses are enough to say the request means it.
pub fn grounded(request: &str, label: &str) -> bool {
    let want = words(label);
    if want.is_empty() {
        return false;
    }
    let have = words(request);
    let shared = want.iter().filter(|w| have.contains(w)).count();
    shared >= 2.min(want.len())
}

/// How many of `label`'s words the request uses.
pub fn overlap(request: &str, label: &str) -> usize {
    let have = words(request);
    words(label).iter().filter(|w| have.contains(w)).count()
}

/// The first quoted or backticked spans of `text`, in order.
pub fn quoted(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let open = chars[i];
        if matches!(open, '`' | '"' | '\u{201c}') {
            let close = if open == '\u{201c}' { '\u{201d}' } else { open };
            if let Some(j) = chars[i + 1..].iter().position(|c| *c == close) {
                out.push(chars[i + 1..i + 1 + j].iter().collect());
                i += j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mention_stands_alone() {
        assert_eq!(mention("push feat-x to origin", "feat-x"), Some(5));
        assert_eq!(mention("push feat-x.", "feat-x"), Some(5));
        assert_eq!(mention("push feat-x2 now", "feat-x"), None);
        assert_eq!(mention("see src/a.py today", "src/a.py"), Some(4));
        assert_eq!(mention("no main branch", "main"), Some(3));
        assert_eq!(mention("domain", "main"), None);
    }

    #[test]
    fn a_repeated_word_counts_once() {
        assert!(!grounded(
            "run the unit tests",
            "tests/integration (python tests: test_integ_core.py)"
        ));
        assert!(grounded(
            "run the unit tests",
            "tests/unit (python tests: test_unit_core.py)"
        ));
    }

    #[test]
    fn grounding_needs_two_shared_words() {
        assert!(grounded(
            "rebuild from the commit that fixed cache eviction",
            "fix cache eviction on shutdown"
        ));
        assert!(!grounded(
            "rebuild from the commit that fixed cache eviction",
            "bump version to 2"
        ));
    }

    #[test]
    fn quotes_come_in_order() {
        assert_eq!(
            quoted("add `a.txt` and \"hi there\" now"),
            vec!["a.txt", "hi there"]
        );
    }
}
