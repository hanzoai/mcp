//! A shell word after expansion: its text, with each part that is not known at the time the
//! command is read replaced by one marker character.

/// Stands for a part of a word whose value is not known: an environment variable, the output
/// of a command, an argument. Input that holds the character is read as unknown there.
pub(crate) const UNK: char = '\u{E000}';

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Val {
    pub s: String,
    /// An unquoted `*`, `?` or `[` stands in the word: it may name many files, never `/` or `..`.
    pub glob: bool,
    /// The word holds an unquoted unknown, which the shell may split into several words.
    pub split: bool,
}

impl Val {
    pub fn lit(s: impl Into<String>) -> Val {
        let s: String = s.into();
        let glob = false;
        Val { s, glob, split: false }
    }

    pub fn unknown() -> Val {
        Val { s: UNK.to_string(), glob: false, split: false }
    }

    pub fn has_unknown(&self) -> bool {
        self.s.contains(UNK)
    }

    /// Nothing of the word is known.
    pub fn is_unknown(&self) -> bool {
        !self.s.is_empty() && self.s.chars().all(|c| c == UNK)
    }

    /// The text when the word is one known string.
    pub fn exact(&self) -> Option<&str> {
        (!self.has_unknown() && !self.glob).then_some(self.s.as_str())
    }

    /// The text when no part of it is unknown (a glob is its own pattern).
    pub fn known(&self) -> Option<&str> {
        (!self.has_unknown()).then_some(self.s.as_str())
    }

    pub fn is(&self, text: &str) -> bool {
        self.exact() == Some(text)
    }

    pub fn starts(&self, prefix: &str) -> bool {
        self.s.starts_with(prefix)
    }

    /// The word as a reason shows it: unknown parts as `…`, at most 80 characters.
    pub fn show(&self) -> String {
        let text = self.s.replace("/\u{1}rhome", "~").replace("/\u{1}workspace", ".").replace("/\u{1}remote", "~");
        let mut out = String::new();
        let mut last_unknown = false;
        for c in text.chars() {
            if c == UNK {
                if !last_unknown {
                    out.push('…');
                }
                last_unknown = true;
            } else {
                last_unknown = false;
                out.push(if c.is_control() { ' ' } else { c });
            }
            if out.chars().count() >= 80 {
                out.push('…');
                break;
            }
        }
        out
    }
}

/// Replaces the marker in text that came from outside, so a command cannot pose as unknown.
pub(crate) fn plain(text: &str) -> String {
    text.chars().map(|c| if c == UNK { '\u{FFFD}' } else { c }).collect()
}
