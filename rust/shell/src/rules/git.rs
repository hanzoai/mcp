//! `git`: what each subcommand reads, changes, discards and sends.

use super::{getopt, Opts};
use crate::path::Place;
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Walker};

/// Branch names a push should not overwrite.
fn protected(refname: &str) -> bool {
    let r = refname.trim_start_matches('+').trim_start_matches("refs/heads/").trim_start_matches("refs/tags/");
    let r = r.rsplit(':').next().unwrap_or(r);
    let r = r.trim_start_matches("refs/heads/");
    matches!(r, "main" | "master" | "trunk" | "develop" | "development" | "prod" | "production" | "stable" | "live" | "release" | "HEAD")
        || r.starts_with("release/")
        || r.starts_with("release-")
        || r.starts_with("hotfix/")
        || r.starts_with("prod/")
        || r.starts_with("production/")
}

/// Configuration keys a person may set for a command without any of them running a program.
fn benign_key(key: &str, value: &str) -> bool {
    let k = key.to_ascii_lowercase();
    const PREFIXES: &[&str] = &["color.", "advice.", "user.", "log.", "status.", "pull.", "push.", "init.", "rebase.", "tag.", "branch.", "column."];
    if PREFIXES.iter().any(|p| k.starts_with(p)) {
        return true;
    }
    match k.as_str() {
        "core.quotepath" | "core.autocrlf" | "core.whitespace" | "core.filemode" | "core.safecrlf" | "core.precomposeunicode" | "core.ignorecase" | "core.longpaths" | "core.untrackedcache" | "core.abbrev" | "core.eol" | "core.symlinks" | "core.preloadindex" | "core.commentchar" => true,
        "core.pager" => matches!(value, "cat" | "less" | "" | "less -FRX" | "less -R"),
        "core.hookspath" => value == "/dev/null",
        "core.fsmonitor" => value == "false",
        "diff.algorithm" | "diff.colormoved" | "diff.renames" | "diff.context" | "diff.noprefix" | "diff.submodule" | "merge.ff" | "merge.conflictstyle" | "merge.renames" | "fetch.prune" | "fetch.prunetags" | "fetch.parallel" | "fetch.recursesubmodules" | "commit.gpgsign" | "commit.verbose" | "gc.auto" | "protocol.version" | "submodule.recurse" | "feature.manyfiles" | "maintenance.auto" | "safe.directory" | "http.sslverify_" | "credential.helper_" => true,
        _ => false,
    }
}

impl Walker<'_> {
    pub(crate) fn git_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if name != "git" {
            return None;
        }
        let mut i = 0;
        let mut repo: Option<Val> = None;
        while i < args.len() {
            let a = &args[i];
            if a.is_unknown() {
                // A subcommand or option named by an expansion.
                self.ask(Kind::Unparsed, "git with an option or subcommand it cannot read");
                return Some(Out::default());
            }
            let t = a.s.as_str();
            match t {
                "-C" => {
                    if let Some(d) = args.get(i + 1) {
                        repo = Some(match &repo {
                            Some(r) if !d.starts("/") => Val::lit(format!("{}/{}", r.s.trim_end_matches('/'), d.s)),
                            _ => d.clone(),
                        });
                    }
                    i += 2;
                }
                "-c" => {
                    if let Some(kv) = args.get(i + 1) {
                        let text = kv.s.as_str();
                        let (k, v) = text.split_once('=').unwrap_or((text, ""));
                        if kv.has_unknown() || !benign_key(k, v) {
                            self.ask(Kind::Code, format!("git -c sets {k}, which can run a program or redirect the remote"));
                        }
                    }
                    i += 2;
                }
                "--config-env" => {
                    self.ask(Kind::Code, "git --config-env sets configuration from the environment");
                    i += 2;
                }
                "--exec-path" => {
                    self.ask(Kind::Code, "git --exec-path changes where its programs are found");
                    i += 1;
                }
                "--git-dir" | "--work-tree" | "--namespace" | "--super-prefix" | "--attr-source" => i += 2,
                t if t.starts_with("--exec-path=") => {
                    self.ask(Kind::Code, "git --exec-path changes where its programs are found");
                    i += 1;
                }
                t if t.starts_with("--git-dir=") || t.starts_with("--work-tree=") => {
                    if let Some((_, d)) = t.split_once('=') {
                        repo = Some(Val::lit(d.to_string()));
                    }
                    i += 1;
                }
                t if t.starts_with('-') => i += 1,
                _ => break,
            }
        }
        let sub = match args.get(i) {
            Some(a) if a.exact().is_some() => a.s.clone(),
            Some(_) => {
                self.ask(Kind::Unparsed, "git with a subcommand it cannot read");
                return Some(Out::default());
            }
            None => return Some(Out::default()),
        };
        let rest = &args[i + 1..];
        // The directory the subcommand works in, for anything it writes.
        let mut work_state;
        let st2: &mut State = match &repo {
            Some(r) => {
                work_state = st.clone();
                work_state.cwd = match (r.exact(), &st.cwd) {
                    (Some(t), _) if t.starts_with('/') => Some(crate::path::normalize(t)),
                    (Some(t), Some(c)) => Some(crate::path::normalize(&format!("{c}/{t}"))),
                    _ => None,
                };
                &mut work_state
            }
            None => st,
        };
        self.git_sub(&sub, rest, repo.as_ref(), io, st2);
        Some(Out::default())
    }

    /// Asks about a subcommand that changes the repository when that is not the workspace's.
    fn git_local(&mut self, sub: &str, repo: Option<&Val>, st: &State) {
        let here = Val::lit(".");
        let s = self.sense(&here, st);
        match s.place {
            Place::Work | Place::Anchor | Place::Temp | Place::TempRoot => {}
            Place::Unknown => self.ask(Kind::Write, format!("git {sub} in a directory it cannot locate")),
            _ => {
                let shown = repo.map(|r| r.show()).unwrap_or_else(|| "the current directory".into());
                self.ask(Kind::Write, format!("git {sub} changes a repository outside the workspace: {shown}"));
            }
        }
    }

    fn git_sub(&mut self, sub: &str, rest: &[Val], repo: Option<&Val>, io: &Io, st: &mut State) {
        match sub {
            "status" | "log" | "diff" | "show" | "blame" | "annotate" | "shortlog" | "describe" | "rev-parse" | "rev-list" | "ls-files" | "ls-tree" | "ls-remote" | "cat-file" | "whatchanged" | "show-ref" | "show-branch" | "for-each-ref" | "merge-base" | "name-rev" | "count-objects" | "diff-tree" | "diff-files" | "diff-index" | "cherry" | "verify-commit" | "verify-tag" | "verify-pack" | "fsck" | "help" | "version" | "var" | "check-ignore" | "check-attr" | "check-ref-format" | "get-tar-commit-id" | "grep" | "range-diff" | "fast-export" | "mergetool--lib" | "stripspace" | "column" | "ls-remote_" | "bugreport_" | "cvsexportcommit_" | "unpack-file" | "show-index" | "merge-tree" | "merge-file" | "interpret-trailers" | "mailinfo" | "mailsplit" | "patch-id" | "rev-list_" | "difftool_" | "diagnose_" => {
                let o = getopt(rest, "", &["output"]);
                if let Some(f) = o.val("output") {
                    let f = f.clone();
                    self.write_path(&f, st, "git writes");
                }
                if o.has('O') {
                    // diff -O orderfile: read.
                }
                if sub == "diff" || sub == "log" || sub == "show" {
                    if o.long("ext-diff") || o.long("textconv") {
                        // Only runs what the configuration names.
                    }
                }
                self.git_paths_read(&o, st);
            }
            "archive" => {
                let o = getopt(rest, "o", &["output", "remote", "exec", "prefix", "format"]);
                if o.val("exec").is_some() {
                    self.ask(Kind::Code, "git archive runs a program on the remote");
                }
                if let Some(f) = o.val("o").or_else(|| o.val("output")) {
                    let f = f.clone();
                    self.write_path(&f, st, "git writes");
                }
            }
            "format-patch" => {
                let o = getopt(rest, "o", &["output-directory", "start-number", "subject-prefix", "cover-letter", "to", "cc", "from"]);
                if o.long("stdout") {
                    return;
                }
                match o.val("o").or_else(|| o.val("output-directory")) {
                    Some(d) => {
                        let d = d.clone();
                        self.write_path(&d, st, "git writes patches to");
                    }
                    None => self.git_local(sub, repo, st),
                }
            }
            "bundle" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                if verb == "create" {
                    if let Some(f) = rest.get(1) {
                        let f = f.clone();
                        self.write_path(&f, st, "git writes");
                    }
                }
            }
            "reflog" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                if matches!(verb, "expire" | "delete") {
                    self.deny(Kind::Destructive, format!("git reflog {verb} destroys the record that recovers lost work"));
                }
            }
            "stash" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("push");
                match verb {
                    "list" | "show" => {}
                    "drop" | "clear" => self.ask(Kind::Destructive, format!("git stash {verb} discards saved work")),
                    "branch" | "push" | "save" | "pop" | "apply" | "create" | "store" | "export" | "import" => self.git_local(sub, repo, st),
                    v if v.starts_with('-') => self.git_local(sub, repo, st),
                    _ => self.git_local(sub, repo, st),
                }
            }
            "worktree" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                match verb {
                    "list" => {}
                    "add" | "move" => {
                        let o = getopt(&rest[1..], "bBn", &["reason"]);
                        let p = o.all_ops().next().cloned();
                        if let Some(p) = p {
                            self.write_path(&p, st, "creates a worktree at");
                        }
                    }
                    _ => self.git_local(sub, repo, st),
                }
            }
            "submodule" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("status");
                match verb {
                    "status" | "summary" => {}
                    "foreach" => {
                        if let Some(c) = rest.iter().skip(1).find(|a| !a.starts("-")) {
                            let c = c.clone();
                            self.nested_string(&c, st, "git submodule foreach");
                        }
                    }
                    _ => self.git_local(sub, repo, st),
                }
            }
            "remote" => {
                let verb = rest.iter().find(|a| !a.starts("-")).and_then(|v| v.exact()).unwrap_or("");
                if matches!(verb, "add" | "remove" | "rm" | "rename" | "set-url" | "set-head" | "set-branches" | "prune") {
                    self.git_local(sub, repo, st);
                    if verb == "set-url" || verb == "add" {
                        if let Some(u) = rest.iter().filter(|a| !a.starts("-")).nth(2) {
                            if u.starts("ext::") {
                                self.deny(Kind::Code, "a git remote of the ext:: kind runs a program");
                            }
                        }
                    }
                }
            }
            "branch" => {
                let o = getopt(rest, "", &["set-upstream-to", "contains", "merged", "no-merged", "sort", "format", "points-at", "unset-upstream_"]);
                if o.has('d') || o.has('D') || o.has('m') || o.has('M') || o.has('c') || o.has('C') || o.has('u') || o.has('f') || o.val("set-upstream-to").is_some() || o.long("delete") || o.long("move") || o.long("copy") || o.long("force") || o.long("edit-description") || (!o.ops.is_empty() && !o.has('l') && !o.long("list") && !o.long("contains") && !o.long("merged") && !o.long("no-merged") && !o.long("points-at")) {
                    self.git_local(sub, repo, st);
                }
            }
            "tag" => {
                let o = getopt(rest, "um", &["list", "contains", "merged", "no-merged", "points-at", "sort", "format", "message", "local-user"]);
                if !(o.has('l') || o.long("list") || o.has('v') || o.has('n') || o.long("verify") || (o.ops.is_empty() && !o.has('d') && !o.has('a') && !o.has('s') && !o.has('f'))) {
                    self.git_local(sub, repo, st);
                }
            }
            "config" => self.git_config(rest, repo, st),
            "add" => {
                let o = getopt(rest, "", &["chmod", "pathspec-from-file"]);
                for v in o.all_ops() {
                    let s = self.sense(v, st);
                    if let Some(secret) = s.secret {
                        self.ask(Kind::Credential, format!("git add stages {secret}: {}", v.show()));
                    }
                }
                self.git_local(sub, repo, st);
            }
            "commit" | "merge" | "cherry-pick" | "revert" | "am" | "apply" | "mv" | "rm" | "pull" | "fetch" | "init" | "notes" | "rerere" | "maintenance" | "gc" | "repack" | "pack-refs" | "update-index" | "symbolic-ref" | "hash-object" | "mktree" | "commit-tree" | "write-tree" | "read-tree" | "checkout-index" | "unpack-objects" | "index-pack" | "fast-import" | "replace" | "subtree" | "sparse-checkout" | "lfs" | "commit-graph" | "multi-pack-index" | "prune-packed" | "refs" | "backfill" | "scalar" | "update-server-info" | "mailinfo_" | "restore-index_" | "bisect--helper_" => {
                let o = getopt(rest, "mFCcSsXtOpdb", &["message", "file", "reuse-message", "reedit-message", "author", "date", "gpg-sign", "exec", "strategy", "strategy-option", "into-name", "upload-pack", "receive-pack", "prune_", "template", "separate-git-dir", "depth", "shallow-since", "shallow-exclude", "jobs", "recurse-submodules_", "directory", "include", "exclude", "reject_"]);
                if sub == "gc" || sub == "prune" {
                    if o.longs.iter().any(|l| l == "prune") && o.vals.iter().any(|(n, v)| n == "prune" && v.s == "now") {
                        self.ask(Kind::Destructive, "git gc --prune=now deletes unreachable objects, which recover lost work");
                    }
                }
                if o.val("upload-pack").is_some() || o.val("receive-pack").is_some() {
                    self.ask(Kind::Code, format!("git {sub} runs a program on the remote"));
                }
                if sub == "lfs" {
                    let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                    if verb == "push" {
                        self.ask(Kind::Publishing, "git lfs push sends files to the remote");
                    } else if verb == "prune" {
                        self.ask(Kind::Destructive, "git lfs prune deletes local copies");
                    }
                    return;
                }
                if matches!(sub, "pull" | "fetch" | "ls-remote") {
                    return;
                }
                if sub == "init" {
                    if let Some(d) = o.all_ops().next() {
                        let d = d.clone();
                        self.write_path(&d, st, "git init creates");
                        return;
                    }
                }
                if sub == "rm" && o.has('r') && o.all_ops().any(|v| v.is(".") || v.is("*") || v.is(":/")) {
                    self.ask(Kind::Destructive, "git rm -r . removes every tracked file");
                }
                if sub == "update-index" {
                    // --assume-unchanged and the like hide changes: no more than a local mark.
                }
                if sub == "apply" && (o.long("check") || o.long("stat") || o.long("numstat") || o.long("summary")) {
                    return;
                }
                self.git_local(sub, repo, st);
            }
            "clone" => {
                let o = getopt(rest, "ubcjo", &["upload-pack", "template", "reference", "origin", "branch", "separate-git-dir", "depth", "config", "jobs", "filter", "shallow-since", "shallow-exclude", "bundle-uri", "server-option", "recurse-submodules_", "revision"]);
                if o.val("u").is_some() || o.val("upload-pack").is_some() {
                    self.ask(Kind::Code, "git clone runs a program on the remote");
                }
                if let Some(c) = o.val("c").or_else(|| o.val("config")) {
                    let (k, v) = c.s.split_once('=').unwrap_or((c.s.as_str(), ""));
                    if !benign_key(k, v) {
                        self.ask(Kind::Code, format!("git clone sets {k}, which can run a program"));
                    }
                }
                let ops: Vec<&Val> = o.all_ops().collect();
                if let Some(u) = ops.first() {
                    if u.starts("ext::") {
                        self.deny(Kind::Code, "a git url of the ext:: kind runs a program");
                    }
                }
                match ops.get(1) {
                    Some(d) => {
                        let d = (*d).clone();
                        self.write_path(&d, st, "git clone writes");
                    }
                    None => {
                        // The name comes from the url, in the working directory.
                        self.write_path(&Val::lit("./x"), st, "git clone writes");
                    }
                }
            }
            "checkout" | "switch" | "restore" => self.git_discard(sub, rest, repo, st),
            "reset" => {
                let o = getopt(rest, "", &[]);
                if o.long("hard") {
                    self.deny(Kind::Destructive, "git reset --hard discards uncommitted work");
                } else if o.long("merge") || o.long("keep") {
                    self.git_local(sub, repo, st);
                } else {
                    self.git_local(sub, repo, st);
                }
            }
            "clean" => {
                let o = getopt(rest, "e", &["exclude"]);
                let dry = o.has('n') || o.long("dry-run");
                let force = o.has('f') || o.long("force");
                if force && !dry {
                    self.deny(Kind::Destructive, "git clean -f deletes untracked files for good");
                } else if !dry && !force && !o.has('i') {
                    // Refuses without -f.
                }
            }
            "rebase" => {
                let o = getopt(rest, "xsXSC", &["exec", "onto", "strategy", "strategy-option", "gpg-sign", "empty"]);
                if let Some(c) = o.val("x").or_else(|| o.val("exec")) {
                    let c = c.clone();
                    self.nested_string(&c, st, "git rebase --exec");
                }
                self.git_local(sub, repo, st);
            }
            "bisect" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                if verb == "run" {
                    let cmd: Vec<Val> = rest.iter().skip(1).cloned().collect();
                    if !cmd.is_empty() {
                        let mut s = st.clone();
                        self.run(cmd, &[], io, &mut s);
                    }
                }
                self.git_local(sub, repo, st);
            }
            "push" => self.git_push(rest),
            "update-ref" => {
                self.ask(Kind::Destructive, "git update-ref moves or deletes a ref directly");
            }
            "filter-branch" | "filter-repo" => self.deny(Kind::Destructive, format!("git {sub} rewrites the whole history")),
            "credential" | "credential-store" | "credential-cache" | "credential-osxkeychain" | "credential-manager" => {
                self.deny(Kind::Credential, format!("git {sub} reads or stores credentials"));
            }
            "difftool" | "mergetool" | "web--browse" | "instaweb" | "gui" | "gitk" | "citool" => self.ask(Kind::Code, format!("git {sub} starts another program")),
            "send-email" | "request-pull_" | "svn" | "p4" | "cvsimport" | "daemon" | "http-backend" | "imap-send" | "remote-ext" => self.ask(Kind::Network, format!("git {sub} talks to another system")),
            "shell" | "receive-pack" | "upload-pack" | "upload-archive" => self.ask(Kind::Network, format!("git {sub} serves a repository")),
            other => self.ask(Kind::Unknown, format!("unknown git subcommand: {other}")),
        }
    }

    /// Pathspecs and revisions after a read-only subcommand: a path that is a credential is read.
    fn git_paths_read(&mut self, o: &Opts, st: &State) {
        for v in &o.after {
            let s = self.sense(v, st);
            if let Some(secret) = s.secret {
                self.deny(Kind::Credential, format!("git reads {secret}: {}", v.show()));
            }
        }
    }

    fn git_discard(&mut self, sub: &str, rest: &[Val], repo: Option<&Val>, st: &State) {
        let o = getopt(rest, "bBcCS", &["source", "conflict", "orphan", "pathspec-from-file", "branch", "create", "force-create", "detach_"]);
        let force = o.has('f') || o.long("force") || o.long("discard-changes");
        let sweeping = |v: &Val| matches!(v.exact(), Some(".") | Some("./") | Some(":/") | Some("*") | Some(":/.") | Some("../")) || v.s.starts_with(":(top)") || v.s.ends_with("/.") && !v.s.contains(".git");
        let after = !o.after.is_empty() || sub == "restore";
        let sweeps = o.after.iter().any(|v| sweeping(v)) || (sub == "restore" && o.all_ops().any(|v| sweeping(v))) || (sub == "checkout" && o.ops.iter().any(|v| sweeping(v)));
        let staged_only = sub == "restore" && o.long("staged") && !o.long("worktree") && !o.has('W');
        let _ = after;
        if sweeps && !staged_only {
            self.deny(Kind::Destructive, format!("git {sub} . discards every uncommitted change in the tree"));
            return;
        }
        if force && sub != "restore" {
            self.ask(Kind::Destructive, format!("git {sub} --force discards uncommitted changes"));
        }
        self.git_local(sub, repo, st);
    }

    fn git_config(&mut self, rest: &[Val], repo: Option<&Val>, st: &State) {
        let o = getopt(rest, "f", &["file", "type", "default", "blob", "get-urlmatch_"]);
        let reading = o.long("get") || o.long("get-all") || o.long("get-regexp") || o.long("list") || o.has('l') || o.long("get-urlmatch") || o.long("show-origin") || o.long("name-only") || o.long("show-scope") || o.long("get-color") || o.long("get-colorbool") || o.long("includes");
        let writing = o.long("add") || o.long("unset") || o.long("unset-all") || o.long("replace-all") || o.long("rename-section") || o.long("remove-section") || o.has('e') || o.long("edit") || o.long("unset_");
        let ops: Vec<&Val> = o.all_ops().collect();
        let global = o.long("global") || o.long("system") || o.has('f') || o.long("file") || o.long("worktree_");
        if o.has('e') || o.long("edit") {
            self.ask(Kind::Code, "git config --edit opens an editor");
            return;
        }
        let sets = writing || (!reading && ops.len() >= 2);
        if !sets {
            return;
        }
        let key = ops.first().map(|v| v.s.to_ascii_lowercase()).unwrap_or_default();
        let value = ops.get(1).map(|v| v.s.clone()).unwrap_or_default();
        if global {
            self.ask(Kind::Write, "git config writes a configuration file outside the repository");
        } else {
            self.git_local("config", repo, st);
        }
        let runs = key.starts_with("alias.") && value.starts_with('!')
            || key.starts_with("filter.") || key.starts_with("diff.") && !benign_key(&key, &value) || key.starts_with("merge.") && !benign_key(&key, &value)
            || key.starts_with("credential.") || key.starts_with("url.") || key.starts_with("include") || key.starts_with("http.")
            || matches!(key.as_str(), "core.sshcommand" | "core.fsmonitor" | "core.pager" | "core.editor" | "core.hookspath" | "core.askpass" | "core.gitproxy" | "gpg.program" | "sequence.editor" | "protocol.ext.allow" | "uploadpack.packobjectshook" | "init.templatedir" | "core.attributesfile" | "core.excludesfile")
            || key.starts_with("gpg.") || key.starts_with("sendemail.") || key.starts_with("difftool.") || key.starts_with("mergetool.") || key.starts_with("pager.");
        if runs && !benign_key(&key, &value) {
            self.ask(Kind::Code, format!("git config sets {key}, which can run a program or redirect the remote"));
        }
    }

    fn git_push(&mut self, rest: &[Val]) {
        let o = getopt(rest, "o", &["repo", "push-option", "receive-pack", "exec", "signed", "force-with-lease", "recurse-submodules", "force-if-includes_"]);
        if o.val("receive-pack").is_some() || o.val("exec").is_some() {
            self.ask(Kind::Code, "git push runs a program on the remote");
        }
        if o.has('n') || o.long("dry-run") {
            return;
        }
        let ops: Vec<&Val> = o.all_ops().collect();
        let refs: Vec<String> = ops.iter().skip(1).map(|v| v.s.clone()).collect();
        let forced = o.has('f') || o.long("force") || o.longs.iter().any(|l| l.starts_with("force-with-lease") || l == "force-if-includes") || o.long("mirror") || o.long("delete") || o.has('d') || refs.iter().any(|r| r.starts_with('+') || r.starts_with(':'));
        let all = o.long("all") || o.long("mirror") || o.long("branches");
        let touches_protected = refs.iter().any(|r| protected(r)) || (refs.is_empty() && (forced || all)) || all && forced;
        if forced && touches_protected {
            self.deny(Kind::Publishing, "a forced push, or a deletion, of a protected branch or of whatever the remote's default is");
        } else if forced {
            self.ask(Kind::Publishing, "a forced push or a ref deletion");
        } else if refs.iter().any(|r| protected(r)) {
            self.ask(Kind::Publishing, "pushes to a protected branch");
        } else {
            self.ask(Kind::Publishing, "pushes to a remote");
        }
    }
}
