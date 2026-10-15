//! Commands that talk to the network and to other machines: what they fetch, what they send,
//! and what they run on the far side.

use super::{getopt, Opts};
use crate::context::Context;
use crate::path::remote_operand;
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Stdin, Walker};

/// Hosts that answer with the credentials of the machine asking.
fn metadata_host(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["169.254.169.254", "metadata.google.internal", "100.100.100.200", "fd00:ec2::254", "169.254.170.2", "metadata.azure.com", "metadata.tencentyun.com"].iter().any(|h| t.contains(h))
}

impl Walker<'_> {
    pub(crate) fn net_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        match name {
            "curl" => return Some(self.curl(args, io, st)),
            "wget" | "wget2" => return Some(self.wget(args, st)),
            "http" | "https" | "xh" | "xhs" | "curlie" => {
                let o = getopt(args, "", &["auth", "auth-type", "body", "headers_", "print", "session", "session-read-only", "output", "proxy", "cert", "cert-key", "verify", "timeout", "download_", "path-as-is_"]);
                let mut write = false;
                let mut it = o.ops.iter().peekable();
                let method = it.peek().and_then(|v| v.exact()).map(|m| m.to_ascii_uppercase());
                match method.as_deref() {
                    Some("GET") | Some("HEAD") | Some("OPTIONS") => {}
                    Some("POST") | Some("PUT") | Some("PATCH") | Some("DELETE") => write = true,
                    _ => {}
                }
                if o.ops.iter().skip(1).any(|v| v.s.contains(":=") || v.s.contains("==") && false || (v.s.contains('=') && !v.s.contains("==")) || v.s.contains("=@") || v.s.contains(":@")) {
                    write = true;
                }
                if write || o.has('f') || o.long("form") || o.long("json") {
                    self.ask(Kind::Network, format!("{name} sends data over the network"));
                }
                if let Some(f) = o.val("output").or_else(|| o.val("o")) {
                    let f = f.clone();
                    self.write_path(&f, st, "writes");
                }
                return Some(Out { literal: None, net: true });
            }
            "aria2c" => {
                let o = getopt(args, "dosiS", &["dir", "out", "input-file", "log", "save-session"]);
                for k in ["d", "dir", "o", "out", "log", "save-session"] {
                    if let Some(v) = o.val(k) {
                        let v = v.clone();
                        if k == "o" || k == "out" {
                            self.write_path(&v, st, "downloads to");
                        } else {
                            self.write_path(&v, st, "downloads into");
                        }
                    }
                }
                if o.val("i").is_some() || o.val("input-file").is_some() {
                    let f = o.val("i").or_else(|| o.val("input-file")).cloned().unwrap_or_else(Val::unknown);
                    self.read_path(&f, st, "reads");
                }
                if o.long("on-download-complete") || o.longs.iter().any(|l| l.starts_with("on-")) {
                    self.ask(Kind::Code, "aria2c runs a hook program");
                }
            }
            "nc" | "ncat" | "netcat" | "socat" | "telnet" | "ftp" | "tftp" | "pftp" | "lftp" | "busybox-nc" | "nmap" | "masscan" | "zmap" | "nikto" | "sqlmap" | "hydra" | "medusa" | "john" | "hashcat" | "msfconsole" | "msfvenom" | "tcpdump" | "tshark" | "wireshark" | "ettercap" | "aircrack-ng" | "responder" | "bettercap" | "proxychains" | "proxychains4" | "tor" | "torsocks" => {
                self.ask(Kind::Network, format!("{name} opens raw network connections or probes hosts"));
            }
            "ssh" => {
                self.ssh(args, io, st);
            }
            "scp" => self.scp(args, st),
            "sftp" => {
                let o = getopt(args, "bBcDFiJloPRSsXO", &[]);
                if let Some(b) = o.val("b") {
                    let b = b.clone();
                    self.read_path(&b, st, "reads");
                }
                self.ask(Kind::Network, "sftp transfers files with a remote host");
            }
            "ssh-keygen" => {
                let o = getopt(args, "tbCfmNOPYGKaJZ", &[]);
                if o.has('l') || o.has('F') {
                    // Fingerprints and lookups print nothing secret.
                    return Some(Out::default());
                }
                if o.has('y') {
                    if let Some(f) = o.val("f") {
                        let f = f.clone();
                        self.read_path(&f, st, "ssh-keygen reads");
                    }
                    return Some(Out::default());
                }
                if let Some(f) = o.val("f") {
                    let f = f.clone();
                    self.write_path(&f, st, "ssh-keygen writes");
                }
                self.ask(Kind::Credential, "ssh-keygen creates or changes keys");
            }
            "ssh-add" | "ssh-agent" | "ssh-copy-id" | "ssh-keyscan" | "gpg" | "gpg2" | "gpgconf" | "gpg-agent" | "age" | "age-keygen" | "pass" | "passwd" | "chpasswd" | "vault" | "op" | "bw" | "lpass" | "keepassxc-cli" | "secret-tool" | "kwallet-query" | "gnome-keyring-daemon" | "keyctl" | "sops" => {
                self.credential_tool(name, args, st);
            }
            _ => return None,
        }
        Some(Out::default())
    }

    fn credential_tool(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "", &[]);
        let harmless = match name {
            "gpg" | "gpg2" => o.has('v') && o.ops.is_empty() || o.long("version") || o.long("list-keys") || o.has('k') || o.long("list-public-keys") || o.long("verify") || o.has('K') && false || o.long("fingerprint"),
            "ssh-keyscan" => true,
            "ssh-add" => o.has('l') || o.has('L'),
            "sops" => o.long("version"),
            _ => false,
        };
        if harmless {
            return;
        }
        let _ = st;
        match name {
            "pass" | "vault" | "op" | "bw" | "lpass" | "keepassxc-cli" | "secret-tool" | "kwallet-query" | "keyctl" | "sops" => {
                let verbs = ["show", "read", "get", "item", "export", "dump", "lookup", "list_", "print", "decrypt", "-d", "kv", "login", "unlock", "ls_", "find_"];
                if args.iter().any(|a| a.exact().is_some_and(|t| verbs.contains(&t))) || args.is_empty() || name == "sops" {
                    self.deny(Kind::Credential, format!("{name} reads secrets from a store"));
                } else {
                    self.ask(Kind::Credential, format!("{name} changes or reads a secret store"));
                }
            }
            "passwd" | "chpasswd" => self.deny(Kind::Privilege, format!("{name} changes a password")),
            "gpg" | "gpg2" | "gpgconf" | "gpg-agent" => {
                if o.has('d') || o.long("decrypt") || o.long("export-secret-keys") || o.long("export-secret-subkeys") || o.long("export-ownertrust") {
                    self.deny(Kind::Credential, "gpg decrypts or exports secret key material");
                } else {
                    self.ask(Kind::Credential, "gpg signs, encrypts or changes the keyring");
                }
            }
            "age" => {
                if o.has('d') || o.long("decrypt") {
                    self.deny(Kind::Credential, "age decrypts");
                }
            }
            _ => self.ask(Kind::Credential, format!("{name} works with ssh or gpg keys")),
        }
    }

    fn curl(&mut self, args: &[Val], io: &Io, st: &State) -> Out {
        let o: Opts = getopt(
            args,
            "AbcCdDeEFHKmoPrTuUwxXyYzQ",
            &[
                "data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "form", "form-string", "header", "output", "output-dir", "upload-file", "request", "user", "url", "user-agent", "cookie", "cookie-jar", "dump-header", "referer", "range", "max-time", "connect-timeout", "retry", "retry-delay", "retry-max-time", "proxy", "proxy-user",
                "cert", "key", "cacert", "capath", "config", "write-out", "json", "trace", "trace-ascii", "limit-rate", "interface", "resolve", "connect-to", "unix-socket", "netrc-file", "aws-sigv4", "oauth2-bearer", "variable", "stderr", "libcurl", "proxy-header", "pinnedpubkey", "ciphers", "tls-max", "tlsv1.3_", "parallel-max", "etag-save", "etag-compare", "ftp-port", "krb", "mail-from", "mail-rcpt", "quote", "telnet-option", "time-cond", "continue-at", "expect100-timeout", "happy-eyeballs-timeout-ms", "dns-servers", "doh-url", "hsts", "alt-svc", "ech", "ssl-sessions", "cert-type", "key-type", "proto", "proto-redir", "speed-limit", "speed-time", "max-filesize", "max-redirs", "keepalive-time", "local-port", "noproxy", "preproxy", "proxy-cacert", "proxy-cert", "proxy-key", "proxy-service-name", "service-name", "socks5-gssapi-service", "sasl-authzid", "login-options", "oauth2-bearer_", "request-target", "haproxy-clientip", "ip-tos", "vlan-priority", "unix-socket_", "abstract-unix-socket",
            ],
        );
        let mut writes_net = o.has('d') || o.has('F') || o.has('T') || o.long("data") || o.long("data-raw") || o.long("data-binary") || o.long("data-urlencode") || o.long("data-ascii") || o.long("form") || o.long("form-string") || o.long("upload-file") || o.long("json");
        if o.long("get") || o.has('G') {
            writes_net = o.has('T') || o.long("upload-file");
        }
        if let Some(m) = o.val("X").or_else(|| o.val("request")) {
            let m = m.s.to_ascii_uppercase();
            if !matches!(m.as_str(), "GET" | "HEAD" | "OPTIONS" | "") {
                writes_net = true;
            }
        }
        if o.has('K') || o.long("config") {
            let f = o.val("K").or_else(|| o.val("config")).cloned().unwrap_or_else(Val::unknown);
            self.read_path(&f, st, "reads");
            self.ask(Kind::Code, "curl takes its options from a file");
        }
        // Data and uploads that name a file: the file leaves the machine.
        let mut sources: Vec<Val> = Vec::new();
        for (n, v) in &o.vals {
            let from_file = |s: &str| -> Option<String> {
                if let Some(rest) = s.strip_prefix('@') {
                    return Some(rest.to_string());
                }
                if let Some(i) = s.find("=@").or_else(|| s.find("=<")) {
                    return Some(s[i + 2..].to_string());
                }
                if n == "data-urlencode" {
                    if let Some(i) = s.find('@') {
                        return Some(s[i + 1..].to_string());
                    }
                }
                None
            };
            match n.as_str() {
                "d" | "data" | "data-raw_" | "data-binary" | "data-ascii" | "data-urlencode" | "F" | "form" | "form-string_" | "json" => {
                    if let Some(f) = from_file(&v.s) {
                        let f = f.split(';').next().unwrap_or(&f).to_string();
                        if f != "-" {
                            sources.push(Val::lit(f));
                        }
                    }
                }
                "T" | "upload-file" => {
                    if v.s != "-" {
                        sources.push(v.clone());
                    }
                }
                _ => {}
            }
        }
        for s in &sources {
            self.read_path(s, st, "sends");
        }
        for (n, v) in &o.vals {
            match n.as_str() {
                "o" | "output" | "D" | "dump-header" | "c" | "cookie-jar" | "trace" | "trace-ascii" | "stderr" | "libcurl" | "etag-save" | "hsts" | "alt-svc" => {
                    if v.s != "-" {
                        let v = v.clone();
                        self.write_path(&v, st, "curl writes");
                    }
                }
                "output-dir" => {
                    let v = v.clone();
                    self.write_path(&v, st, "curl writes into");
                }
                "b" | "cookie" => {
                    if !v.s.contains('=') {
                        let v = v.clone();
                        self.read_path(&v, st, "reads");
                    }
                }
                "cert" | "E" | "key" | "cacert" | "capath" | "netrc-file" | "proxy-cert" | "proxy-key" => {
                    let v = Val::lit(v.s.split(':').next().unwrap_or(&v.s).to_string());
                    self.use_path(&v, st, "curl uses");
                }
                "unix-socket" | "abstract-unix-socket" => self.ask(Kind::Privilege, "curl talks to a unix socket, which may be a service's control channel"),
                _ => {}
            }
        }
        if o.has('O') || o.long("remote-name") || o.long("remote-name-all") {
            let dir = o.val("output-dir").cloned().map(|d| format!("{}/", d.s.trim_end_matches('/'))).unwrap_or_default();
            self.write_path(&Val::lit(format!("{dir}x")), st, "curl writes");
        }
        let mut files_out = o.val("o").is_some() || o.val("output").is_some() || o.has('O') || o.long("remote-name") || o.long("remote-name-all");
        let urls: Vec<&Val> = o.ops.iter().chain(o.after.iter()).chain(o.vals.iter().filter(|(n, _)| n == "url").map(|(_, v)| v)).collect();
        let mut hosts = Vec::new();
        for u in &urls {
            let t = u.s.as_str();
            if metadata_host(t) {
                self.deny(Kind::Credential, format!("reads instance metadata, which hands out cloud credentials: {}", u.show()));
            }
            if let Some(path) = t.strip_prefix("file://") {
                let path = path.trim_start_matches("localhost");
                self.read_path(&Val::lit(path.to_string()), st, "curl reads");
                files_out = files_out || false;
            } else {
                hosts.push(t);
            }
            if t.starts_with("gopher://") || t.starts_with("dict://") || t.starts_with("ldap://") || t.starts_with("smtp://") || t.starts_with("smtps://") || t.starts_with("telnet://") || t.starts_with("tftp://") || t.starts_with("imap://") || t.starts_with("pop3://") {
                self.ask(Kind::Network, format!("curl speaks {} to {}", t.split("://").next().unwrap_or(""), u.show()));
            }
            if (t.starts_with("scp://") || t.starts_with("sftp://") || t.starts_with("ftp://")) && (o.has('T') || o.long("upload-file")) {
                writes_net = true;
            }
        }
        if writes_net {
            let target = hosts.first().map(|h| h.to_string()).unwrap_or_default();
            let target = if target.is_empty() { "a server".to_string() } else { crate::val::plain(&target.chars().take(60).collect::<String>()) };
            self.ask(Kind::Network, format!("curl sends data to {target}"));
        }
        let _ = io;
        Out { literal: None, net: !files_out }
    }

    fn wget(&mut self, args: &[Val], st: &State) -> Out {
        let o = getopt(args, "OPoaeiBUtTwlQxDRAIXHCnN", &["output-document", "directory-prefix", "output-file", "append-output", "execute", "input-file", "post-data", "post-file", "body-data", "body-file", "method", "header", "load-cookies", "save-cookies", "certificate", "private-key", "ca-certificate", "user", "password", "http-user", "http-password", "user-agent", "referer", "tries", "timeout", "wait", "limit-rate", "level", "accept", "reject", "domains", "exclude-domains", "include-directories", "exclude-directories", "proxy-user", "proxy-password", "bind-address", "secure-protocol", "ca-directory", "crl-file", "random-file", "egd-file", "config", "base", "default-page", "backup-converted_", "warc-file"]);
        let mut writes_net = o.val("post-data").is_some() || o.val("post-file").is_some() || o.val("body-data").is_some() || o.val("body-file").is_some();
        if let Some(m) = o.val("method") {
            if !matches!(m.s.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS") {
                writes_net = true;
            }
        }
        for k in ["post-file", "body-file", "i", "input-file", "load-cookies"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                if k == "post-file" || k == "body-file" {
                    self.read_path(&f, st, "sends");
                } else {
                    self.read_path(&f, st, "reads");
                }
            }
        }
        if o.val("e").is_some() || o.val("execute").is_some() {
            let e = o.val("e").or_else(|| o.val("execute")).map(|v| v.s.clone()).unwrap_or_default();
            if !e.starts_with("robots=") {
                self.ask(Kind::Code, "wget takes a setting that can change where it writes or what it runs");
            }
        }
        let mut stdout = false;
        for k in ["O", "output-document"] {
            if let Some(f) = o.val(k) {
                if f.s == "-" {
                    stdout = true;
                } else {
                    let f = f.clone();
                    self.write_path(&f, st, "wget writes");
                }
            }
        }
        for k in ["P", "directory-prefix"] {
            if let Some(d) = o.val(k) {
                let d = d.clone();
                self.write_path(&d, st, "wget writes into");
            }
        }
        for k in ["o", "output-file", "a", "append-output", "save-cookies", "warc-file"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                self.write_path(&f, st, "wget writes");
            }
        }
        for k in ["certificate", "private-key", "ca-certificate"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                self.use_path(&f, st, "wget uses");
            }
        }
        for u in o.all_ops() {
            if metadata_host(&u.s) {
                self.deny(Kind::Credential, format!("reads instance metadata, which hands out cloud credentials: {}", u.show()));
            }
        }
        if writes_net {
            self.ask(Kind::Network, "wget sends data over the network");
        }
        if !stdout && o.val("O").is_none() && o.val("output-document").is_none() {
            self.write_path(&Val::lit("./x"), st, "wget writes");
        }
        Out { literal: None, net: stdout }
    }

    fn ssh(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let o = getopt(args, "bcDEeFIiJLlmOopQRSWw", &[]);
        for (n, v) in &o.vals {
            if n == "o" {
                let low = v.s.to_ascii_lowercase();
                if low.starts_with("proxycommand") || low.starts_with("localcommand") || low.starts_with("permitlocalcommand") || low.starts_with("knownhostscommand") || low.starts_with("remotecommand") {
                    self.ask(Kind::Code, "ssh runs a command named in its options");
                }
            }
            if n == "F" {
                self.ask(Kind::Code, "ssh reads a configuration file that can run commands");
            }
            if n == "L" || n == "R" || n == "D" || n == "W" {
                self.ask(Kind::Network, "ssh forwards a port");
            }
        }
        if o.has('N') && o.has('f') {
            self.ask(Kind::Network, "ssh opens a tunnel");
        }
        let mut ops = o.ops.iter().chain(o.after.iter());
        let Some(_host) = ops.next() else { return };
        let cmd: Vec<&Val> = ops.collect();
        if cmd.is_empty() {
            // A shell on the other side, fed whatever comes in on standard input.
            match &io.stdin {
                Stdin::Text(v) => {
                    let text = v.s.clone();
                    self.remote(&text);
                }
                Stdin::Pipe { literal: Some(t), .. } => {
                    let text = t.clone();
                    self.remote(&text);
                }
                Stdin::Inherit => {}
                _ => self.ask(Kind::Code, "ssh opens a shell and feeds it what it cannot read"),
            }
            return;
        }
        let text = cmd.iter().map(|v| v.s.as_str()).collect::<Vec<_>>().join(" ");
        if cmd.iter().all(|v| v.is_unknown()) {
            self.ask(Kind::Code, "ssh runs a command it cannot read");
            return;
        }
        let _ = st;
        self.remote(&text);
    }

    /// Reads `script` as run on another machine: no workspace there, no files to read.
    pub(crate) fn remote(&mut self, script: &str) {
        let ctx = Context { remote: true, cwd: None, home: Some(crate::path::REMOTE_HOME.to_string()), roots: Vec::new(), files: None, ..self.ctx.clone() };
        let mut w = Walker::new(&ctx);
        let mut s = State::start(&ctx);
        w.script(script, &mut s);
        self.found.extend(w.found);
    }

    fn scp(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "cFiJloPSDX", &[]);
        for (n, v) in &o.vals {
            if n == "o" {
                let low = v.s.to_ascii_lowercase();
                if low.starts_with("proxycommand") || low.starts_with("localcommand") {
                    self.ask(Kind::Code, "scp runs a command named in its options");
                }
            }
            if n == "S" || n == "F" {
                self.ask(Kind::Code, "scp runs a program of its own");
            }
        }
        let ops: Vec<Val> = o.all_ops().cloned().collect();
        let Some((dest, srcs)) = ops.split_last() else { return };
        for s in srcs {
            if remote_operand(&s.s) {
                continue;
            }
            self.read_path(s, st, "sends");
        }
        if remote_operand(&dest.s) {
            self.ask(Kind::Network, format!("sends files to a remote host: {}", dest.show()));
        } else {
            self.write_path(dest, st, "copies to");
        }
    }
}
