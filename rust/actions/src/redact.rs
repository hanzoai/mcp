//! Secrets out of anything an action records: tokens, keys and passwords become `[redacted]`
//! before a ledger line, a cache entry or a step's argv is written.

use regex::Regex;
use std::sync::OnceLock;

const PATTERNS: &[&str] = &[
    r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}",
    r"\bsk-[A-Za-z0-9_-]{16,}",
    r"\bhk-[A-Za-z0-9_-]{12,}",
    r"\bgh[pousr]_[A-Za-z0-9]{20,}",
    r"\bglpat-[A-Za-z0-9_-]{16,}",
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
    r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[=:]\s*)[^\s,;&]+",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
];

fn rules() -> &'static [Regex] {
    static RULES: OnceLock<Vec<Regex>> = OnceLock::new();
    RULES.get_or_init(|| PATTERNS.iter().filter_map(|p| Regex::new(p).ok()).collect())
}

/// `text` with every credential-shaped span replaced.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for rule in rules() {
        out = rule
            .replace_all(&out, |caps: &regex::Captures| {
                match (caps.get(1), caps.get(2)) {
                    (Some(name), Some(sep)) => {
                        format!("{}{}[redacted]", name.as_str(), sep.as_str())
                    }
                    _ => "[redacted]".to_string(),
                }
            })
            .into_owned();
    }
    out
}

/// Whether an environment variable's name says it holds a credential.
pub fn secret(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
        .iter()
        .any(|w| n.contains(w))
}

/// `text` cut to at most `n` bytes on a character boundary.
pub fn cut(text: &str, n: usize) -> String {
    if text.len() <= n {
        return text.to_string();
    }
    let mut end = n;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_replaced_and_prose_is_not() {
        let text = "token=abc123def Authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnopqrst ok plain words";
        let got = redact(text);
        assert!(!got.contains("abc123def"), "{got}");
        assert!(!got.contains("abcdefghijklmnop"), "{got}");
        assert!(!got.contains("sk-abcdef"), "{got}");
        assert!(got.contains("ok plain words"), "{got}");
    }

    #[test]
    fn names_of_secrets_are_found() {
        assert!(secret("HANZO_API_KEY"));
        assert!(secret("claude_code_oauth_token"));
        assert!(!secret("PATH"));
    }
}
