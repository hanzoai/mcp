//! Commands that create, change, move and remove files.

// Rule tables name a verb under its group and again under any group; the first arm that matches decides.
#![allow(unreachable_patterns)]

use super::{getopt, Opts};
use crate::path::{remote_operand, Place};
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Stdin, Walker};

impl Walker<'_> {
    pub(crate) fn file_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        match name {
            "rm" | "unlink" | "rmdir" | "shred" | "trash" | "rmtrash" | "trash-put" => self.rm(name, args, st),
            "mv" => self.mv(args, st),
            "cp" => self.cp(args, st),
            "ln" => self.ln(args, st),
            "install" => self.install(args, st),
            "mkdir" => {
                let o = getopt(args, "m", &["mode"]);
                for v in o.all_ops() {
                    self.write_path(v, st, "creates");
                }
            }
            "touch" => {
                let o = getopt(args, "dtr", &["date", "reference"]);
                for v in o.all_ops() {
                    self.write_path(v, st, "touches");
                }
            }
            "mkfifo" | "mknod" => {
                let o = getopt(args, "m", &["mode"]);
                for v in o.all_ops().take(1) {
                    self.write_path(v, st, "creates");
                }
            }
            "chmod" => self.chmod(args, st),
            "chown" | "chgrp" => self.chown(name, args, st),
            "truncate" => {
                let o = getopt(args, "sr", &["size", "reference"]);
                for v in o.all_ops() {
                    self.write_path(v, st, "truncates");
                }
            }
            "dd" => self.dd(args, st),
            "tee" => return Some(self.tee(args, io, st)),
            "rsync" => self.rsync(args, st),
            "tar" | "bsdtar" | "gtar" => self.tar(args, st),
            "zip" => {
                let o = getopt(args, "bnptxiqTP", &["output-file"]);
                let mut ops = o.all_ops();
                if let Some(a) = ops.next() {
                    self.write_path(a, st, "writes");
                }
                for v in ops {
                    self.read_path(v, st, "archives");
                }
            }
            "unzip" | "zipinfo" => {
                let o = getopt(args, "dxpPoO", &[]);
                let list_only = o.has('l') || o.has('p') || o.has('t') || o.has('Z') || name == "zipinfo";
                let mut ops = o.all_ops();
                if let Some(a) = ops.next() {
                    self.read_path(a, st, "reads");
                }
                if !list_only {
                    match o.val("d") {
                        Some(d) => {
                            let d = d.clone();
                            self.write_path(&d, st, "extracts into");
                        }
                        None => self.write_path(&Val::lit("."), st, "extracts into"),
                    }
                }
            }
            "gzip" | "gunzip" | "bzip2" | "bunzip2" | "xz" | "unxz" | "zstd" | "unzstd" | "lz4" | "unlz4" | "compress" | "uncompress" | "pigz" | "unpigz" | "lzma" | "unlzma" | "lzip" => {
                let o = getopt(args, "SbFsCT", &["suffix", "threads"]);
                let reads = o.has('c') || o.long("stdout") || o.has('t') || o.has('l') || o.long("test") || o.long("list") || o.has('h') || o.has('V');
                for v in o.all_ops() {
                    if reads {
                        self.read_path(v, st, "reads");
                    } else {
                        self.write_path(v, st, "compresses in place");
                    }
                }
            }
            "zcat" | "gzcat" | "bzcat" | "xzcat" | "zstdcat" | "lzcat" | "unzstdcat" | "zless" | "bzless" | "xzless" | "zgrep" | "zegrep" | "bzgrep" | "xzgrep" => {
                let o = getopt(args, "", &[]);
                for v in o.all_ops() {
                    self.read_path(v, st, "reads");
                }
            }
            "7z" | "7za" | "7zr" | "7zz" => {
                let sub = args.first().and_then(|a| a.exact()).unwrap_or("").to_string();
                let rest: Vec<Val> = args.iter().skip(1).filter(|a| !a.starts("-")).cloned().collect();
                match sub.as_str() {
                    "a" | "u" | "d" | "rn" => {
                        if let Some(a) = rest.first() {
                            self.write_path(a, st, "writes");
                        }
                        for v in rest.iter().skip(1) {
                            self.read_path(v, st, "archives");
                        }
                    }
                    "x" | "e" => {
                        if let Some(a) = rest.first() {
                            self.read_path(a, st, "reads");
                        }
                        self.write_path(&Val::lit("."), st, "extracts into");
                    }
                    "l" | "t" | "i" | "h" | "b" => {
                        for v in &rest {
                            self.read_path(v, st, "reads");
                        }
                    }
                    _ => self.ask(Kind::Unknown, format!("{name} with a command it cannot read")),
                }
            }
            "split" | "csplit" => {
                let o = getopt(args, "abCdlnux", &["bytes", "lines", "line-bytes", "number", "suffix-length", "additional-suffix", "filter"]);
                if o.val("filter").is_some() {
                    self.ask(Kind::Code, "split runs a filter command");
                }
                let mut ops = o.all_ops();
                if let Some(f) = ops.next() {
                    self.read_path(f, st, "reads");
                }
                let prefix = ops.next().cloned().unwrap_or_else(|| Val::lit(if name == "split" { "x" } else { "xx" }));
                self.write_path(&prefix, st, "writes pieces to");
            }
            "patch" => {
                let o = getopt(args, "pidDoVbBzr", &["input", "directory", "output", "reject-file"]);
                if let Some(f) = o.val("i").or_else(|| o.val("input")) {
                    let f = f.clone();
                    self.read_path(&f, st, "reads");
                }
                if let Some(d) = o.val("d").or_else(|| o.val("directory")) {
                    let d = d.clone();
                    self.write_path(&d, st, "patches in");
                }
                if let Stdin::File(f) = &io.stdin {
                    let f = f.clone();
                    self.read_path(&f, st, "reads");
                }
                for v in o.all_ops() {
                    if !(o.has('C') || o.long("check") || o.long("dry-run")) {
                        self.write_path(v, st, "patches");
                    }
                }
            }
            "vi" | "vim" | "nvim" | "view" | "nano" | "pico" | "emacs" | "ed" | "ex" | "micro" | "joe" | "mcedit" | "vimdiff" | "emacsclient" => {
                self.ask(Kind::Code, format!("{name} opens an editor, which can run commands and change files"));
            }
            "open" | "xdg-open" | "gnome-open" | "start" | "explorer" | "wslview" => {
                self.ask(Kind::Code, format!("{name} hands a file or a link to another program"));
            }
            "mktemp" => {
                let o = getopt(args, "p", &["tmpdir"]);
                if let Some(d) = o.val("p").or_else(|| o.val("tmpdir")) {
                    let d = d.clone();
                    self.write_path(&d, st, "creates in");
                }
                for t in o.all_ops() {
                    self.write_path(t, st, "creates");
                }
            }
            "rename" | "prename" => {
                let o = getopt(args, "", &[]);
                for v in o.all_ops().skip(2) {
                    self.write_path(v, st, "renames");
                }
            }
            "sync" | "fsync" => {}
            "attr" | "setfattr" | "xattr" => self.ask(Kind::Write, format!("{name} changes file attributes")),
            "setfacl" | "chattr" | "chcon" | "setcap" | "restorecon" => self.ask(Kind::Privilege, format!("{name} changes permissions or attributes")),
            "mount" | "umount" | "losetup" | "swapon" | "swapoff" | "fsck" | "tune2fs" | "resize2fs" | "e2fsck" | "lvremove" | "lvreduce" | "vgremove" | "pvremove" | "cryptsetup" | "parted" => {
                if name == "mount" && args.is_empty() {
                    return Some(Out::default());
                }
                self.deny(Kind::Privilege, format!("{name} changes mounted filesystems or devices"));
            }
            "mkfs" | "wipefs" | "fdisk" | "sfdisk" | "cfdisk" | "mkswap" | "blkdiscard" | "gdisk" | "sgdisk" | "badblocks" | "hdparm" | "sdparm" | "nvme" | "dmsetup" | "blockdev" => {
                if matches!(name, "fdisk" | "sfdisk" | "parted" | "gdisk" | "sgdisk" | "hdparm" | "nvme" | "blockdev" | "badblocks") && getopt(args, "", &[]).has('l') {
                    return Some(Out::default());
                }
                self.deny(Kind::Destructive, format!("{name} destroys or rewrites a filesystem or a disk"));
            }
            n if n.starts_with("mkfs.") => self.deny(Kind::Destructive, format!("{n} makes a filesystem, destroying what the device held")),
            _ => return None,
        }
        Some(Out::default())
    }

    fn rm(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "", &["interactive"]);
        if o.long("no-preserve-root") {
            self.deny(Kind::Destructive, "rm --no-preserve-root removes the root");
        }
        let recursive = name == "rm" && (o.has('r') || o.has('R') || o.long("recursive"));
        if recursive && o.opaque {
            self.ask(Kind::Destructive, "recursive remove with an argument it cannot read");
        } else if o.opaque && o.ops.iter().any(|v| v.split) {
            self.ask(Kind::Destructive, "rm with an expansion that may hold options and files");
        }
        for v in o.all_ops() {
            if v.is_unknown() && !recursive {
                continue;
            }
            self.remove_path(v, st, recursive);
        }
    }

    fn mv(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "tS", &["target-directory", "suffix"]);
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        let (dest, srcs): (Option<Val>, Vec<Val>) = match o.val("t").or_else(|| o.val("target-directory")) {
            Some(d) => (Some(d.clone()), ops),
            None => match ops.split_last() {
                Some((d, s)) => (Some(d.clone()), s.to_vec()),
                None => (None, vec![]),
            },
        };
        for s in &srcs {
            let sn = self.sense(s, st);
            if let Some(secret) = sn.secret {
                self.deny(Kind::Credential, format!("moves {secret}: {}", s.show()));
                continue;
            }
            match sn.place {
                Place::System | Place::Disk => self.deny(Kind::Privilege, format!("moves a system path: {}", s.show())),
                Place::Root | Place::Broad | Place::Home | Place::Anchor => self.deny(Kind::Destructive, format!("moves {}, a directory that is not for moving", s.show())),
                Place::Home | Place::HomeSub | Place::Outside => self.ask(Kind::Write, format!("moves from outside the workspace: {}", s.show())),
                _ => {}
            }
        }
        if let Some(d) = dest {
            self.write_path(&d, st, "moves to");
        }
    }

    fn cp(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "tS", &["target-directory", "suffix"]);
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        let (dest, srcs): (Option<Val>, Vec<Val>) = match o.val("t").or_else(|| o.val("target-directory")) {
            Some(d) => (Some(d.clone()), ops),
            None => match ops.split_last() {
                Some((d, s)) => (Some(d.clone()), s.to_vec()),
                None => (None, vec![]),
            },
        };
        for s in &srcs {
            self.read_path(s, st, "copies");
        }
        if let Some(d) = dest {
            self.write_path(&d, st, "copies to");
        }
    }

    fn ln(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "tS", &["target-directory", "suffix"]);
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        let (target, link) = match ops.as_slice() {
            [t] => (Some(t.clone()), None),
            [t, l] => (Some(t.clone()), Some(l.clone())),
            [.., l] => (ops.first().cloned(), Some(l.clone())),
            _ => (None, None),
        };
        if let Some(l) = link {
            self.write_path(&l, st, "links at");
        }
        if let Some(t) = target {
            // A link from the workspace to a path outside it reaches that path as though it were inside.
            let abs = if t.starts("/") || o.has('s') && t.starts("/") { t.clone() } else { Val::lit(format!("{}/..", ".")) };
            let _ = abs;
            let sn = self.sense(&t, st);
            if let Some(secret) = sn.secret {
                self.ask(Kind::Credential, format!("links to {secret}: {}", t.show()));
            } else if t.starts("/") && !matches!(sn.place, Place::Work | Place::Anchor | Place::Temp | Place::TempRoot | Place::Null) {
                self.ask(Kind::Write, format!("links to a path outside the workspace: {}", t.show()));
            } else if t.s.split('/').filter(|c| *c == "..").count() > 0 && !t.starts("/") {
                self.ask(Kind::Traversal, format!("links to a path that climbs: {}", t.show()));
            }
        }
    }

    fn install(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "mogGtS", &["mode", "owner", "group", "target-directory", "suffix"]);
        if let Some(own) = o.val("o").or_else(|| o.val("owner")) {
            if own.s.trim() == "root" {
                self.deny(Kind::Privilege, "install hands files to root");
            }
        }
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        if o.has('d') || o.long("directory") {
            for v in &ops {
                self.write_path(v, st, "creates");
            }
            return;
        }
        match o.val("t").or_else(|| o.val("target-directory")) {
            Some(d) => {
                let d = d.clone();
                self.write_path(&d, st, "installs into");
                for s in &ops {
                    self.read_path(s, st, "installs");
                }
            }
            None => {
                if let Some((d, s)) = ops.split_last() {
                    self.write_path(d, st, "installs to");
                    for v in s {
                        self.read_path(v, st, "installs");
                    }
                }
            }
        }
    }

    fn chmod(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "", &["reference"]);
        let recursive = o.has('R') || o.long("recursive");
        let mut ops: Vec<Val> = o.all_ops().cloned().collect();
        if o.val("reference").is_none() && !ops.is_empty() {
            let mode = ops.remove(0);
            let m = mode.s.clone();
            let digits: Vec<char> = m.chars().collect();
            let setid = (digits.len() == 4 && digits.iter().all(|c| c.is_digit(8)) && matches!(digits[0], '2' | '4' | '6' | '7')) || m.contains("+s") || m.contains("u+s") || m.contains("g+s") || m.contains("=s");
            if setid {
                self.deny(Kind::Privilege, "chmod sets a setuid or setgid bit");
            }
            if recursive && matches!(m.as_str(), "777" | "000" | "a+rwx" | "ugo+rwx" | "a-rwx" | "u-rwx" | "go-rwx" | "0777") {
                for v in &ops {
                    let s = self.sense(v, st);
                    if matches!(s.place, Place::Root | Place::Broad | Place::Home | Place::System | Place::Anchor) {
                        self.deny(Kind::Destructive, format!("chmod -R {m} on {}", v.show()));
                    }
                }
            }
        }
        for v in &ops {
            if recursive {
                let s = self.sense(v, st);
                if matches!(s.place, Place::Root | Place::Broad | Place::System | Place::Home) {
                    self.deny(Kind::Destructive, format!("recursive chmod of {}", v.show()));
                    continue;
                }
            }
            self.write_path(v, st, "changes the mode of");
        }
    }

    fn chown(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "", &["reference", "from"]);
        let recursive = o.has('R') || o.long("recursive");
        let mut ops: Vec<Val> = o.all_ops().cloned().collect();
        if o.val("reference").is_none() && !ops.is_empty() {
            let owner = ops.remove(0);
            let t = owner.s.trim();
            if t == "root" || t.starts_with("root:") || t.starts_with("root.") || t == "0" || t.starts_with("0:") || (name == "chgrp" && (t == "root" || t == "0" || t == "wheel" || t == "sudo" || t == "admin")) {
                self.deny(Kind::Privilege, format!("{name} hands files to root"));
            }
        }
        for v in &ops {
            if recursive {
                let s = self.sense(v, st);
                if matches!(s.place, Place::Root | Place::Broad | Place::System | Place::Home) {
                    self.deny(Kind::Destructive, format!("recursive {name} of {}", v.show()));
                    continue;
                }
            }
            self.write_path(v, st, "changes the owner of");
        }
    }

    fn dd(&mut self, args: &[Val], st: &State) {
        for a in args {
            let t = a.s.as_str();
            if let Some(f) = t.strip_prefix("of=") {
                let v = Val::lit(f.to_string());
                let v = if a.has_unknown() { Val { s: f.to_string(), glob: false, split: false } } else { v };
                let s = self.sense(&v, st);
                if matches!(s.place, Place::Disk) {
                    self.deny(Kind::Destructive, format!("dd writes a device: {}", v.show()));
                } else {
                    self.write_path(&v, st, "dd writes");
                }
            } else if let Some(f) = t.strip_prefix("if=") {
                let v = Val { s: f.to_string(), glob: false, split: false };
                self.read_path(&v, st, "dd reads");
            }
        }
    }

    fn tee(&mut self, args: &[Val], io: &Io, st: &State) -> Out {
        let o = getopt(args, "", &["output-error"]);
        let text = match &io.stdin {
            Stdin::Text(v) if v.exact().is_some() => Some(v.s.clone()),
            Stdin::Pipe { literal: Some(t), .. } => Some(t.clone()),
            _ => None,
        };
        for v in o.all_ops() {
            self.write_path(v, st, "tee writes");
            if let (Some(t), Some(abs)) = (&text, self.resolve(v, st)) {
                self.wrote.entry(abs).and_modify(|e| e.push_str(t)).or_insert_with(|| t.clone());
            }
        }
        let net = matches!(io.stdin, Stdin::Pipe { net: true, .. });
        Out { literal: if io.out_file { None } else { text }, net }
    }

    fn rsync(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "eTBfM", &["rsh", "exclude", "include", "exclude-from", "include-from", "files-from", "filter", "log-file", "partial-dir", "backup-dir", "suffix", "compare-dest", "copy-dest", "link-dest", "port", "bwlimit", "timeout", "contimeout", "max-size", "min-size", "chmod", "usermap", "groupmap", "chown", "address", "sockopts", "temp-dir", "write-batch", "read-batch"]);
        if o.val("e").is_some() || o.val("rsh").is_some() {
            self.ask(Kind::Code, "rsync runs a remote shell program of its own");
        }
        let deleting = o.longs.iter().any(|l| l.starts_with("delete") || l == "remove-source-files");
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        let Some((dest, srcs)) = ops.split_last() else { return };
        let dest_remote = remote_operand(&dest.s);
        for s in srcs {
            if remote_operand(&s.s) {
                self.ask(Kind::Network, format!("reads from a remote host: {}", s.show()));
            } else {
                self.read_path(s, st, "copies");
            }
        }
        if dest_remote {
            self.ask(Kind::Network, format!("sends files to a remote host: {}", dest.show()));
        } else {
            self.write_path(dest, st, "copies to");
            if deleting {
                let sn = self.sense(dest, st);
                if !matches!(sn.place, Place::Work | Place::Temp) {
                    self.deny(Kind::Destructive, format!("rsync deletes files in {}", dest.show()));
                } else {
                    self.ask(Kind::Destructive, format!("rsync deletes files in {}", dest.show()));
                }
            }
        }
    }

    fn tar(&mut self, args: &[Val], st: &State) {
        // The first word may be a bundle of mode letters without a dash.
        let mut words: Vec<Val> = args.to_vec();
        if let Some(first) = words.first() {
            if let Some(t) = first.exact() {
                if !t.starts_with('-') && t.chars().all(|c| c.is_ascii_alphabetic()) && !t.is_empty() {
                    words[0] = Val::lit(format!("-{t}"));
                }
            }
        }
        let o = getopt(&words, "fCTXIFLsbNKHVgMRZ", &["file", "directory", "files-from", "exclude-from", "use-compress-program", "to-command", "checkpoint-action", "info-script", "new-volume-script", "rsh-command", "transform", "xform", "exclude", "newer", "newer-mtime", "after-date", "index-file", "label", "listed-incremental", "owner", "group", "mode", "strip-components", "wildcards-match", "atime-preserve", "blocking-factor", "tape-length", "volno-file", "level", "occurrence"]);
        for (n, what) in [("use-compress-program", "a compress program"), ("to-command", "a command for each member"), ("checkpoint-action", "a checkpoint action"), ("info-script", "a volume script"), ("new-volume-script", "a volume script"), ("rsh-command", "a remote shell")] {
            if o.val(n).is_some() || o.long(n) {
                self.ask(Kind::Code, format!("tar runs {what}"));
            }
        }
        if o.val("I").is_some() || o.val("F").is_some() {
            self.ask(Kind::Code, "tar runs a program (-I or -F)");
        }
        if o.has('P') || o.long("absolute-names") {
            self.ask(Kind::Write, "tar keeps absolute names, so it can write anywhere");
        }
        let create = o.has('c') || o.long("create") || o.has('r') || o.long("append") || o.has('u') || o.long("update") || o.has('A') || o.long("catenate") || o.long("concatenate");
        let extract = o.has('x') || o.long("extract") || o.long("get");
        let archive = o.val("f").or_else(|| o.val("file")).cloned();
        let dir = o.val("C").or_else(|| o.val("directory")).cloned();
        if let Some(a) = &archive {
            if a.s != "-" {
                if create {
                    self.write_path(a, st, "writes");
                } else {
                    self.read_path(a, st, "reads");
                }
            }
        }
        if let Some(t) = o.val("T").or_else(|| o.val("files-from")) {
            let t = t.clone();
            self.read_path(&t, st, "reads names from");
        }
        if create {
            for v in o.all_ops() {
                // Members are named relative to the directory given with -C.
                let v = match &dir {
                    Some(d) if !v.starts("/") => Val::lit(format!("{}/{}", d.s.trim_end_matches('/'), v.s)),
                    _ => v.clone(),
                };
                self.read_path(&v, st, "archives");
            }
        }
        if extract {
            match &dir {
                Some(d) => {
                    let d = d.clone();
                    self.write_path(&d, st, "extracts into");
                }
                None => self.write_path(&Val::lit("."), st, "extracts into"),
            }
        }
    }
}

#[allow(dead_code)]
fn unused(_: Opts) {}
