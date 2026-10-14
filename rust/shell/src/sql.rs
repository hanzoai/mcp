//! What a SQL statement does to a database, read from its text.

pub(crate) enum Sql {
    /// Only reads.
    Reads,
    /// Changes data or schema.
    Writes(String),
    /// Destroys data: a drop, a truncate, a delete of every row.
    Destroys(String),
    /// Runs a program or reads or writes a file on the server.
    Runs(String),
    Unreadable,
}

/// Strips comments and the contents of strings, so keywords are found only where they are
/// keywords.
fn clean(sql: &str) -> Option<String> {
    let c: Vec<char> = sql.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '-' if c.get(i + 1) == Some(&'-') => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            '#' if i == 0 || c[i - 1] == '\n' => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
            }
            '/' if c.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < c.len() && !(c[i] == '*' && c[i + 1] == '/') {
                    i += 1;
                }
                if i + 1 >= c.len() {
                    return None;
                }
                i += 2;
                out.push(' ');
            }
            q @ ('\'' | '"' | '`') => {
                i += 1;
                let mut closed = false;
                while i < c.len() {
                    if c[i] == '\\' && q == '\'' {
                        i += 2;
                        continue;
                    }
                    if c[i] == q {
                        if c.get(i + 1) == Some(&q) {
                            i += 2;
                            continue;
                        }
                        closed = true;
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    return None;
                }
                out.push_str(if q == '"' { " ident " } else { " '' " });
            }
            '$' => {
                // $tag$ ... $tag$ (PostgreSQL).
                let mut j = i + 1;
                while j < c.len() && (c[j].is_alphanumeric() || c[j] == '_') {
                    j += 1;
                }
                if c.get(j) == Some(&'$') {
                    let tag: String = c[i..=j].iter().collect();
                    let body_start = j + 1;
                    let rest: String = c[body_start..].iter().collect();
                    match rest.find(&tag) {
                        Some(k) => {
                            let skipped = rest[..k].chars().count();
                            i = body_start + skipped + tag.chars().count();
                            out.push_str(" '' ");
                            continue;
                        }
                        None => return None,
                    }
                }
                out.push('$');
                i += 1;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    Some(out)
}

pub(crate) fn scan(sql: &str) -> Sql {
    // The client's own commands: psql's `\`, sqlite's `.`.
    let mut statements = String::new();
    for line in sql.lines() {
        let t = line.trim_start();
        if let Some(meta) = t.strip_prefix('\\') {
            let low = meta.to_ascii_lowercase();
            if low.starts_with('!') || low.starts_with("copy") && low.contains("program") || low.starts_with("gexec") || low.starts_with('o') && !low.starts_with("o ") && low.len() > 1 && false {
                return Sql::Runs("a client shell escape".into());
            }
            if low.starts_with("o ") || low.starts_with("w ") || low.starts_with("copy ") {
                return Sql::Writes("a client command that writes a file".into());
            }
            continue;
        }
        if let Some(dot) = t.strip_prefix('.') {
            let low = dot.to_ascii_lowercase();
            let word = low.split_whitespace().next().unwrap_or("");
            match word {
                "shell" | "system" | "load" => return Sql::Runs(format!("the .{word} command")),
                "output" | "once" | "backup" | "save" | "import" | "clone" | "excel" | "recover" | "restore" | "write" | "dbconfig" => return Sql::Writes(format!("the .{word} command")),
                _ => {}
            }
            if t.starts_with('.') && !word.is_empty() && word.chars().all(|c| c.is_alphabetic()) {
                continue;
            }
        }
        statements.push_str(line);
        statements.push('\n');
    }
    let Some(text) = clean(&statements) else { return Sql::Unreadable };
    let upper = text.to_ascii_uppercase();
    for bad in ["PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_LS_DIR", "PG_STAT_FILE", "LO_IMPORT", "LO_EXPORT", "DBLINK", "XP_CMDSHELL", "LOAD_EXTENSION", "READFILE(", "WRITEFILE(", "INTO OUTFILE", "INTO DUMPFILE", "LOAD DATA", "LOAD_FILE", "FILE(", "URL(", "S3(", "EXECUTE_SHELL", "SYSTEM(", "ATTACH DATABASE"] {
        if upper.contains(bad) {
            return Sql::Runs(bad.trim_end_matches('(').to_ascii_lowercase());
        }
    }
    if upper.contains("PROGRAM") && upper.contains("COPY") {
        return Sql::Runs("copy to or from a program".into());
    }
    let mut worst = Sql::Reads;
    for stmt in upper.split(';') {
        let words: Vec<&str> = stmt.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect();
        let Some(first) = words.first().copied() else { continue };
        let has = |w: &str| words.contains(&w);
        let verdict = match first {
            "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "VALUES" | "TABLE" | "USE" | "BEGIN" | "COMMIT" | "ROLLBACK" | "START" | "END" | "SAVEPOINT" | "RELEASE" | "FETCH" | "DECLARE" | "CLOSE" | "ABORT" => {
                if first == "SELECT" && (has("INTO") && !has("INSERT")) && words.iter().position(|w| *w == "INTO").is_some_and(|p| p > 0) && (has("FROM") && words.iter().position(|w| *w == "INTO") < words.iter().position(|w| *w == "FROM") || !has("FROM")) {
                    Sql::Writes("SELECT INTO creates a table".into())
                } else if has("FOR") && (has("UPDATE") || has("SHARE")) {
                    Sql::Writes("SELECT FOR UPDATE locks rows".into())
                } else {
                    Sql::Reads
                }
            }
            "EXPLAIN" => {
                if has("ANALYZE") || has("ANALYSE") {
                    let inner = words.iter().position(|w| matches!(*w, "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "WITH" | "MERGE"));
                    match inner.map(|p| words[p]) {
                        Some("SELECT") | Some("WITH") | None => Sql::Reads,
                        Some(w) => Sql::Writes(format!("EXPLAIN ANALYZE runs the {w}")),
                    }
                } else {
                    Sql::Reads
                }
            }
            "PRAGMA" => {
                if stmt.contains('=') {
                    Sql::Writes("PRAGMA sets an option".into())
                } else {
                    Sql::Reads
                }
            }
            "SET" | "RESET" | "DISCARD" => Sql::Reads,
            "WITH" => {
                if has("DELETE") || has("DROP") || has("TRUNCATE") {
                    Sql::Destroys("a WITH that deletes".into())
                } else if has("INSERT") || has("UPDATE") || has("MERGE") || has("REPLACE") {
                    Sql::Writes("a WITH that writes".into())
                } else {
                    Sql::Reads
                }
            }
            "DROP" | "TRUNCATE" => Sql::Destroys(first.to_ascii_lowercase()),
            "DELETE" => {
                if has("WHERE") {
                    Sql::Writes("DELETE".into())
                } else {
                    Sql::Destroys("DELETE without WHERE".into())
                }
            }
            "ALTER" => {
                if has("DROP") {
                    Sql::Destroys("ALTER ... DROP".into())
                } else {
                    Sql::Writes("ALTER".into())
                }
            }
            "INSERT" | "UPDATE" | "UPSERT" | "REPLACE" | "MERGE" | "COPY" | "LOAD" | "IMPORT" | "CREATE" | "GRANT" | "REVOKE" | "COMMENT" | "REINDEX" | "VACUUM" | "CLUSTER" | "REFRESH" | "CALL" | "DO" | "EXEC" | "EXECUTE" | "LOCK" | "LISTEN" | "NOTIFY" | "PREPARE" | "DEALLOCATE" | "ATTACH" | "DETACH" | "OPTIMIZE" | "SYSTEM" | "KILL" | "ANALYZE" | "RENAME" | "SECURITY" | "REASSIGN" | "IMPORTFOREIGN" | "UNLOAD" | "BACKUP" | "RESTORE" | "SHUTDOWN" | "CHECKPOINT" => Sql::Writes(first.to_ascii_lowercase()),
            _ => Sql::Unreadable,
        };
        worst = max(worst, verdict);
    }
    worst
}

fn rank(s: &Sql) -> u8 {
    match s {
        Sql::Reads => 0,
        Sql::Writes(_) => 1,
        Sql::Unreadable => 2,
        Sql::Destroys(_) => 3,
        Sql::Runs(_) => 4,
    }
}

fn max(a: Sql, b: Sql) -> Sql {
    if rank(&b) > rank(&a) {
        b
    } else {
        a
    }
}
