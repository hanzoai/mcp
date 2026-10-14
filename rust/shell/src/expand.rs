//! Shell words: quotes, escapes, `~`, `$name`, `${…}`, `$(…)`, braces and field splitting,
//! read as the shell reads them, with what cannot be known at read time left unknown.

use brush_parser::word::{self, Parameter, ParameterExpr, SpecialParameter, TildeExpr, WordPiece, WordPieceWithSource};
use brush_parser::{ast, ParserOptions};

use crate::val::{plain, Val, UNK};
use crate::walk::{State, Var, Walker};

/// The most readings of one word that are followed apart; past it the word is unknown.
pub(crate) const ALTS: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// Text the command wrote.
    Lit,
    /// A known value an expansion produced.
    Exp,
    /// An expansion whose value is not known.
    Unk,
}

#[derive(Clone)]
pub(crate) struct Seg {
    pub text: String,
    pub part: Part,
    pub quoted: bool,
}

pub(crate) type Alt = Vec<Seg>;

fn lit(text: impl Into<String>, quoted: bool) -> Seg {
    Seg { text: text.into(), part: Part::Lit, quoted }
}

fn unk(quoted: bool) -> Seg {
    Seg { text: String::new(), part: Part::Unk, quoted }
}

pub(crate) fn options() -> ParserOptions {
    ParserOptions::default()
}

fn has_glob(text: &str) -> bool {
    let b = text.as_bytes();
    b.iter().enumerate().any(|(i, c)| match c {
        b'*' | b'?' => true,
        b'[' => text[i..].contains(']'),
        b'@' | b'+' | b'!' => b.get(i + 1) == Some(&b'('),
        _ => false,
    })
}

/// The fields a reading of a word splits into: unquoted expansions split at blanks.
pub(crate) fn fields_of(alt: &Alt) -> Vec<Val> {
    let mut out: Vec<Val> = Vec::new();
    let mut cur = String::new();
    let mut have = false;
    let mut glob = false;
    let mut split = false;
    let flush = |out: &mut Vec<Val>, cur: &mut String, have: &mut bool, glob: &mut bool, split: &mut bool| {
        if *have {
            out.push(Val { s: std::mem::take(cur), glob: *glob, split: *split });
        }
        *have = false;
        *glob = false;
        *split = false;
    };
    for seg in alt {
        match seg.part {
            Part::Lit => {
                cur.push_str(&seg.text);
                have = true;
                if !seg.quoted && has_glob(&seg.text) {
                    glob = true;
                }
            }
            Part::Unk => {
                cur.push(UNK);
                have = true;
                if !seg.quoted {
                    split = true;
                    glob = true;
                }
            }
            Part::Exp => {
                if seg.quoted {
                    cur.push_str(&seg.text);
                    have = true;
                } else {
                    if seg.text.contains(UNK) {
                        split = true;
                    }
                    if has_glob(&seg.text) {
                        glob = true;
                    }
                    for c in seg.text.chars() {
                        if c == ' ' || c == '\t' || c == '\n' {
                            flush(&mut out, &mut cur, &mut have, &mut glob, &mut split);
                        } else {
                            cur.push(c);
                            have = true;
                        }
                    }
                }
            }
        }
    }
    flush(&mut out, &mut cur, &mut have, &mut glob, &mut split);
    out
}

/// One value out of a reading, with no splitting and no globbing: an assignment's, a
/// redirection's.
pub(crate) fn scalar_of(alt: &Alt) -> Val {
    let mut s = String::new();
    for seg in alt {
        match seg.part {
            Part::Unk => s.push(UNK),
            _ => s.push_str(&seg.text),
        }
    }
    Val { s, glob: false, split: false }
}

/// `$'…'`: the characters its escapes stand for.
pub(crate) fn ansi_c(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] != '\\' || i + 1 >= c.len() {
            out.push(c[i]);
            i += 1;
            continue;
        }
        i += 1;
        let e = c[i];
        i += 1;
        match e {
            'a' => out.push('\u{7}'),
            'b' => out.push('\u{8}'),
            'e' | 'E' => out.push('\u{1b}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'v' => out.push('\u{b}'),
            '\\' | '\'' | '"' | '?' => out.push(e),
            '0'..='7' => {
                let mut n = e.to_digit(8).unwrap_or(0);
                let mut k = 1;
                while k < 3 && i < c.len() && c[i].is_digit(8) {
                    n = n * 8 + c[i].to_digit(8).unwrap_or(0);
                    i += 1;
                    k += 1;
                }
                if let Some(ch) = char::from_u32(n & 0xff).filter(|ch| *ch != '\0') {
                    out.push(ch);
                }
            }
            'x' | 'u' | 'U' => {
                let max = match e {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let mut n = 0u32;
                let mut k = 0;
                while k < max && i < c.len() && c[i].is_ascii_hexdigit() {
                    n = n.wrapping_mul(16).wrapping_add(c[i].to_digit(16).unwrap_or(0));
                    i += 1;
                    k += 1;
                }
                if k == 0 {
                    out.push('\\');
                    out.push(e);
                } else if let Some(ch) = char::from_u32(n).filter(|ch| *ch != '\0') {
                    out.push(ch);
                }
            }
            'c' if i < c.len() => {
                out.push(char::from_u32((c[i] as u32) & 0x1f).unwrap_or(' '));
                i += 1;
            }
            other => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    plain(&out)
}

/// The command inside backquotes, with the escapes the shell takes out first.
pub(crate) fn unbackquote(text: &str) -> String {
    let mut out = String::new();
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(n) = it.peek() {
                if matches!(n, '$' | '`' | '\\') {
                    out.push(*n);
                    it.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// The strings a word's braces make: `{a,b}.c` is `a.c` and `b.c`. A word without braces,
/// or one with too many, is itself.
pub(crate) fn braces(raw: &str) -> Vec<String> {
    if !raw.contains('{') {
        return vec![raw.to_string()];
    }
    match word::parse_brace_expansions(raw, &options()) {
        Ok(Some(items)) => {
            let out = brace_items(&items, 0);
            if out.is_empty() || out.len() > 64 {
                vec![raw.to_string()]
            } else {
                out
            }
        }
        _ => vec![raw.to_string()],
    }
}

fn brace_items(items: &[word::BraceExpressionOrText], depth: usize) -> Vec<String> {
    let mut acc = vec![String::new()];
    if depth > 8 {
        return acc;
    }
    for item in items {
        let opts: Vec<String> = match item {
            word::BraceExpressionOrText::Text(t) => vec![t.clone()],
            word::BraceExpressionOrText::Expr(members) => {
                let mut v = Vec::new();
                for m in members {
                    match m {
                        word::BraceExpressionMember::NumberSequence { start, end, increment } => {
                            let step = if *increment == 0 { 1 } else { increment.abs() };
                            let mut n = *start;
                            let mut k = 0;
                            while (if start <= end { n <= *end } else { n >= *end }) && k < 65 {
                                v.push(n.to_string());
                                n = if start <= end { n.saturating_add(step) } else { n.saturating_sub(step) };
                                k += 1;
                            }
                        }
                        word::BraceExpressionMember::CharSequence { start, end, increment } => {
                            let step = if *increment == 0 { 1 } else { increment.unsigned_abs() as u32 };
                            let (a, b) = (*start as u32, *end as u32);
                            let mut n = a;
                            let mut k = 0;
                            while (if a <= b { n <= b } else { n >= b }) && k < 65 {
                                if let Some(ch) = char::from_u32(n) {
                                    v.push(ch.to_string());
                                }
                                n = if a <= b { n.saturating_add(step) } else { n.saturating_sub(step) };
                                k += 1;
                            }
                        }
                        word::BraceExpressionMember::Child(children) => v.extend(brace_items(children, depth + 1)),
                    }
                }
                v
            }
        };
        let mut next = Vec::new();
        for a in &acc {
            for o in &opts {
                next.push(format!("{a}{o}"));
                if next.len() > 80 {
                    return next;
                }
            }
        }
        acc = next;
    }
    acc
}

impl Walker<'_> {
    /// The lists of words a word may become: usually one list of one word.
    pub(crate) fn fields(&mut self, w: &ast::Word, st: &State) -> Vec<Vec<Val>> {
        let mut lists: Vec<Vec<Val>> = vec![Vec::new()];
        for raw in braces(&w.value) {
            let alts = self.alts(&raw, st);
            let mut next = Vec::new();
            for base in &lists {
                for alt in &alts {
                    let mut l = base.clone();
                    l.extend(fields_of(alt));
                    next.push(l);
                }
            }
            if next.len() > ALTS {
                // Too many readings to follow apart: one, with the word unknown.
                let mut l = lists.into_iter().next().unwrap_or_default();
                l.push(Val { s: UNK.to_string(), glob: true, split: true });
                next = vec![l];
            }
            lists = next;
        }
        lists
    }

    /// The values a word may have where it stays one word: after `=`, after `>`, in `case`.
    pub(crate) fn scalar(&mut self, w: &ast::Word, st: &State) -> Vec<Val> {
        let alts = self.alts(&w.value, st);
        dedup(alts.iter().map(scalar_of).collect())
    }

    pub(crate) fn alts(&mut self, raw: &str, st: &State) -> Vec<Alt> {
        if raw.contains("${(") || raw.contains("${~") || raw.contains("$~") {
            self.ask(crate::verdict::Kind::Unparsed, "the command uses parameter flags or glob substitution (zsh), which can evaluate code");
        }
        match word::parse(raw, &options()) {
            Ok(pieces) => self.pieces(&pieces, false, st),
            Err(_) => {
                self.scan_subst(raw, st);
                self.unread("a word");
                vec![vec![unk(false)]]
            }
        }
    }

    fn pieces(&mut self, ps: &[WordPieceWithSource], quoted: bool, st: &State) -> Vec<Alt> {
        let mut acc: Vec<Alt> = vec![Vec::new()];
        for p in ps {
            let opts = self.piece(&p.piece, quoted, st);
            if acc.len().saturating_mul(opts.len()) > ALTS {
                let mut collapsed = Vec::new();
                for a in acc.iter_mut().take(1) {
                    a.push(unk(quoted));
                    collapsed.push(std::mem::take(a));
                }
                acc = collapsed;
                continue;
            }
            let mut next = Vec::with_capacity(acc.len() * opts.len());
            for a in &acc {
                for o in &opts {
                    let mut m = a.clone();
                    m.extend(o.iter().cloned());
                    next.push(m);
                }
            }
            acc = next;
        }
        acc
    }

    pub(crate) fn piece(&mut self, p: &WordPiece, quoted: bool, st: &State) -> Vec<Alt> {
        match p {
            WordPiece::Text(t) => {
                if !quoted {
                    if let Some(why) = crate::zsh_glob(t) {
                        self.ask(crate::verdict::Kind::Unparsed, format!("the command uses {why}, which the bash grammar reads as a pattern"));
                    }
                }
                vec![vec![lit(t.clone(), quoted)]]
            }
            WordPiece::SingleQuotedText(t) => vec![vec![lit(plain(t), true)]],
            WordPiece::AnsiCQuotedText(t) => vec![vec![lit(ansi_c(t), true)]],
            WordPiece::EscapeSequence(e) => {
                let text = e.strip_prefix('\\').unwrap_or(e);
                vec![vec![lit(text.to_string(), true)]]
            }
            WordPiece::DoubleQuotedSequence(ps) | WordPiece::GettextDoubleQuotedSequence(ps) => {
                let mut out = self.pieces(ps, true, st);
                // `""` is a word of no characters.
                for a in &mut out {
                    if a.is_empty() {
                        a.push(lit("", true));
                    }
                }
                out
            }
            WordPiece::TildeExpansion(t) => vec![vec![self.tilde(t, st)]],
            WordPiece::ParameterExpansion(pe) => self.param(pe, quoted, st),
            WordPiece::CommandSubstitution(s) => vec![vec![self.substitute(s, quoted, st)]],
            WordPiece::BackquotedCommandSubstitution(s) => vec![vec![self.substitute(&unbackquote(s), quoted, st)]],
            WordPiece::ArithmeticExpression(a) => {
                self.scan_subst(&a.value, st);
                vec![vec![unk(quoted)]]
            }
        }
    }

    fn tilde(&mut self, t: &TildeExpr, st: &State) -> Seg {
        match t {
            TildeExpr::Home => match self.home(st) {
                Some(h) => lit(h, true),
                None => unk(true),
            },
            TildeExpr::UserHome(u) if u == "root" => lit("/root", true),
            TildeExpr::WorkingDir => match &st.cwd {
                Some(c) => lit(c.clone(), true),
                None => unk(true),
            },
            _ => unk(true),
        }
    }

    fn home(&self, st: &State) -> Option<String> {
        match st.env.get("HOME") {
            Some(Var::Known(v)) if v.len() == 1 && v[0].known().is_some() => Some(v[0].s.clone()),
            Some(_) => None,
            None => self.ctx.home.clone(),
        }
    }

    fn substitute(&mut self, src: &str, quoted: bool, st: &State) -> Seg {
        let out = self.sub(src, st);
        match out.literal {
            Some(text) => {
                let text = text.trim_end_matches('\n').to_string();
                Seg { text, part: Part::Exp, quoted }
            }
            None => unk(quoted),
        }
    }

    fn lookup(&self, name: &str, st: &State) -> Option<Vec<Val>> {
        match st.env.get(name) {
            Some(Var::Known(v)) => Some(v.clone()),
            Some(Var::Unknown) => None,
            None => match name {
                "HOME" => self.ctx.home.clone().map(|h| vec![Val::lit(h)]),
                "PWD" => st.cwd.clone().filter(|c| !c.starts_with("/\u{1}")).map(|c| vec![Val::lit(c)]),
                "IFS" => Some(vec![Val::lit(" \t\n")]),
                _ => None,
            },
        }
    }

    fn param_value(&mut self, p: &Parameter, indirect: bool, quoted: bool, st: &State) -> Vec<Alt> {
        let unknown = || vec![vec![unk(quoted)]];
        if indirect {
            return unknown();
        }
        match p {
            Parameter::Named(name) if name.starts_with(['(', '~', '=']) => {
                self.ask(crate::verdict::Kind::Unparsed, "parameter flags or glob substitution (zsh), which can evaluate code");
                unknown()
            }
            Parameter::Named(name) => match {
                if crate::rules::secretive(name) {
                    self.cmd_secret = Some(name.clone());
                }
                self.lookup(name, st)
            } {
                Some(vals) if !vals.is_empty() => vals.into_iter().map(|v| vec![Seg { text: v.s, part: Part::Exp, quoted }]).collect(),
                _ => unknown(),
            },
            Parameter::NamedWithIndex { index, .. } => {
                self.scan_subst(index, st);
                unknown()
            }
            Parameter::Special(SpecialParameter::LastBackgroundProcessId) => match st.env.get("!") {
                Some(Var::Known(v)) if !v.is_empty() => v.iter().map(|x| vec![Seg { text: x.s.clone(), part: Part::Exp, quoted }]).collect(),
                _ => unknown(),
            },
            Parameter::Positional(_) | Parameter::Special(_) | Parameter::NamedWithAllIndices { .. } => unknown(),
        }
    }

    fn text_alts(&mut self, text: &Option<String>, quoted: bool, st: &State) -> Vec<Alt> {
        let Some(t) = text else {
            return vec![vec![lit("", quoted)]];
        };
        match word::parse(t, &options()) {
            Ok(ps) => self.pieces(&ps, quoted, st),
            Err(_) => {
                self.scan_subst(t, st);
                vec![vec![unk(quoted)]]
            }
        }
    }

    fn param(&mut self, pe: &ParameterExpr, quoted: bool, st: &State) -> Vec<Alt> {
        use ParameterExpr as P;
        let unknown = |q| vec![vec![unk(q)]];
        match pe {
            P::Parameter { parameter, indirect } => self.param_value(parameter, *indirect, quoted, st),
            P::UseDefaultValues { parameter, indirect, default_value, .. } | P::AssignDefaultValues { parameter, indirect, default_value, .. } => {
                let mut out = self.param_value(parameter, *indirect, quoted, st);
                out.extend(self.text_alts(default_value, quoted, st));
                out.truncate(ALTS);
                out
            }
            P::UseAlternativeValue { parameter, indirect, alternative_value, .. } => {
                let mut out = self.param_value(parameter, *indirect, quoted, st);
                out.extend(self.text_alts(alternative_value, quoted, st));
                out.truncate(ALTS);
                out
            }
            P::IndicateErrorIfNullOrUnset { parameter, indirect, error_message, .. } => {
                let _ = self.text_alts(error_message, quoted, st);
                self.param_value(parameter, *indirect, quoted, st)
            }
            P::ParameterLength { parameter, .. } => {
                let _ = self.param_value(parameter, false, quoted, st);
                unknown(quoted)
            }
            P::RemoveSmallestSuffixPattern { parameter, pattern, .. }
            | P::RemoveLargestSuffixPattern { parameter, pattern, .. }
            | P::RemoveSmallestPrefixPattern { parameter, pattern, .. }
            | P::RemoveLargestPrefixPattern { parameter, pattern, .. }
            | P::UppercaseFirstChar { parameter, pattern, .. }
            | P::UppercasePattern { parameter, pattern, .. }
            | P::LowercaseFirstChar { parameter, pattern, .. }
            | P::LowercasePattern { parameter, pattern, .. } => {
                let _ = self.param_value(parameter, false, quoted, st);
                if let Some(p) = pattern {
                    self.scan_subst(p, st);
                }
                unknown(quoted)
            }
            P::Substring { parameter, offset, length, .. } => {
                let _ = self.param_value(parameter, false, quoted, st);
                self.scan_subst(&offset.value, st);
                if let Some(l) = length {
                    self.scan_subst(&l.value, st);
                }
                unknown(quoted)
            }
            P::Transform { parameter, op, .. } => {
                let _ = self.param_value(parameter, false, quoted, st);
                if matches!(op, word::ParameterTransformOp::PromptExpand) {
                    self.ask(crate::verdict::Kind::Code, "expands a value as a prompt (@P), which runs the commands in it");
                }
                unknown(quoted)
            }
            P::ReplaceSubstring { parameter, pattern, replacement, .. } => {
                let _ = self.param_value(parameter, false, quoted, st);
                self.scan_subst(pattern, st);
                if let Some(r) = replacement {
                    self.scan_subst(r, st);
                }
                unknown(quoted)
            }
            P::VariableNames { .. } | P::MemberKeys { .. } => unknown(quoted),
        }
    }

    /// Finds the commands inside a piece of text the structured reading did not open (a
    /// pattern, an array index, an arithmetic expression) and reads each as a script. It reads
    /// more than the shell would, never less: a quoted `$(` is read too.
    pub(crate) fn scan_subst(&mut self, text: &str, st: &State) {
        let b: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                '\\' => i += 2,
                '$' if b.get(i + 1) == Some(&'(') => {
                    if b.get(i + 2) == Some(&'(') {
                        let Some(end) = matching(&b, i + 1) else {
                            self.unread("an unclosed expansion");
                            return;
                        };
                        let inner: String = b[i + 3..end.saturating_sub(1).max(i + 3)].iter().collect();
                        self.scan_subst(&inner, st);
                        i = end + 1;
                    } else {
                        let Some(end) = matching(&b, i + 1) else {
                            self.unread("an unclosed substitution");
                            return;
                        };
                        let inner: String = b[i + 2..end].iter().collect();
                        self.sub(&inner, st);
                        i = end + 1;
                    }
                }
                '<' | '>' if b.get(i + 1) == Some(&'(') => {
                    let Some(end) = matching(&b, i + 1) else {
                        self.unread("an unclosed substitution");
                        return;
                    };
                    let inner: String = b[i + 2..end].iter().collect();
                    self.sub(&inner, st);
                    i = end + 1;
                }
                '`' => {
                    let mut j = i + 1;
                    while j < b.len() && b[j] != '`' {
                        if b[j] == '\\' {
                            j += 1;
                        }
                        j += 1;
                    }
                    if j >= b.len() {
                        self.unread("an unclosed backquote");
                        return;
                    }
                    let inner: String = b[i + 1..j].iter().collect();
                    self.sub(&unbackquote(&inner), st);
                    i = j + 1;
                }
                _ => i += 1,
            }
        }
    }
}

/// The index of the `)` that closes the `(` at `open`, reading quotes as a shell does.
fn matching(b: &[char], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            '\\' => i += 1,
            '\'' => {
                i += 1;
                while i < b.len() && b[i] != '\'' {
                    i += 1;
                }
            }
            '"' => {
                i += 1;
                while i < b.len() && b[i] != '"' {
                    if b[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

pub(crate) fn dedup(mut v: Vec<Val>) -> Vec<Val> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
    v
}
