//! Commands that read and transform text and files: the filters, the searchers, `sed`,
//! `awk` and `find`.

use super::{getopt, Opts};
use crate::path::Place;
use crate::val::{Val, UNK};
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Stdin, Walker};

/// Commands whose operands are files they read.
const READERS: &[&str] = &[
    "cat", "tac", "head", "tail", "less", "more", "bat", "batcat", "nl", "wc", "od", "hexdump", "xxd", "strings", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "b3sum", "shasum", "md5", "sha256", "base64", "base32", "basenc", "cut", "paste", "fold", "fmt",
    "rev", "comm", "diff", "diff3", "sdiff", "cmp", "colordiff", "column", "expand", "unexpand", "pr", "gron", "xq", "tsv-utils", "csvlook", "csvcut", "miller", "mlr", "nm", "objdump", "readelf", "ldd", "size", "ptx", "tsort", "look", "less.sh", "fx", "jless", "glow", "mdcat", "rich",
];
/// Commands that name files but read only their metadata.
const META: &[&str] = &["ls", "dir", "vdir", "tree", "stat", "file", "du", "df", "readlink", "realpath", "namei", "lsattr", "getfacl", "exa", "eza", "lsd", "dust", "duf", "ncdu", "mdls"];
/// Commands that read and write nothing a path can name.
const PURE: &[&str] = &[
    "id", "whoami", "groups", "uname", "arch", "nproc", "uptime", "free", "vmstat", "iostat", "mpstat", "sar", "lscpu", "lsblk", "lspci", "lsusb", "lsmod", "lshw", "ps", "top", "htop", "btop", "pgrep", "pidof", "pstree", "lsof", "ss", "netstat", "route", "arp", "ping", "ping6", "traceroute", "tracepath", "mtr", "dig", "nslookup", "host",
    "whois", "getent", "locale", "getconf", "tty", "tput", "clear", "reset", "man", "info", "apropos", "whatis", "tldr", "cal", "ncal", "yes", "seq", "factor", "numfmt", "uuidgen", "lsb_release", "sw_vers", "system_profiler", "bc", "dc", "expr", "basename", "dirname", "tr", "printenv_", "nice_", "who", "w", "users", "last", "lastlog", "finger", "logname",
    "tsc_", "sleep", "usleep", "shuf_", "date", "hostname", "stty", "env_", "nproc_", "lsns", "lscgroup", "iotop", "nethogs", "iftop", "dstat", "glances", "neofetch", "fastfetch", "screenfetch", "cpuid", "sensors", "nvidia-smi", "rocm-smi", "radeontop", "intel_gpu_top", "xdpyinfo", "xrandr", "powermetrics", "vm_stat", "sysctl_", "ioreg",
];

impl Walker<'_> {
    pub(crate) fn text_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if READERS.contains(&name) {
            return Some(self.reader(name, args, io, st));
        }
        if META.contains(&name) {
            return Some(Out::default());
        }
        if PURE.contains(&name) {
            self.pure(name, args, st);
            return Some(Out::default());
        }
        match name {
            "grep" | "egrep" | "fgrep" | "rgrep" | "zgrep" | "ack" | "ag" | "pt" | "ugrep" | "ug" | "sift" | "git-grep" => self.grep(name, args, st),
            "rg" => self.rg(args, st),
            "fd" | "fdfind" => self.fd(args, st),
            "sed" | "gsed" => self.sed(args, io, st),
            "awk" | "gawk" | "mawk" | "nawk" => self.awk(name, args, st),
            "find" | "gfind" => self.find(args, io, st),
            "jq" | "gojq" | "jaq" => self.jq(args, st),
            "yq" => self.yq(args, st),
            "sort" | "gsort" => {
                let o = getopt(args, "otkTSsXy", &["output", "temporary-directory", "buffer-size", "key", "field-separator", "files0-from", "parallel", "random-source", "compress-program"]);
                if let Some(f) = o.val("o").or_else(|| o.val("output")) {
                    let f = f.clone();
                    self.write_path(&f, st, "sort writes");
                }
                if o.val("compress-program").is_some() {
                    self.ask(Kind::Code, "sort runs a compress program");
                }
                for v in o.all_ops() {
                    self.read_path(v, st, "reads");
                }
            }
            "uniq" => {
                let o = getopt(args, "fswcz", &["skip-fields", "skip-chars", "check-chars"]);
                let mut ops = o.all_ops();
                if let Some(i) = ops.next() {
                    self.read_path(i, st, "reads");
                }
                if let Some(out) = ops.next() {
                    self.write_path(out, st, "uniq writes");
                }
            }
            "shuf" => {
                let o = getopt(args, "ione", &["output", "input-range", "head-count", "random-source"]);
                if let Some(f) = o.val("o").or_else(|| o.val("output")) {
                    let f = f.clone();
                    self.write_path(&f, st, "shuf writes");
                }
                for v in o.all_ops() {
                    if !o.has('e') && !o.has('i') {
                        self.read_path(v, st, "reads");
                    }
                }
            }
            "printenv" => {
                if args.is_empty() {
                    self.ask(Kind::Credential, "printenv with no name prints the environment, which may hold secrets");
                }
                for a in args {
                    if a.exact().is_some_and(super::builtin::secretive) {
                        self.ask(Kind::Credential, format!("prints the secret variable {}", a.show()));
                    }
                }
            }
            "openssl" => self.openssl(args, st),
            "xxd_" => {}
            "hostnamectl" | "timedatectl" | "localectl" | "loginctl" | "busctl" | "coredumpctl" | "resolvectl" | "networkctl" | "bootctl" => {
                let read = args.is_empty() || args.iter().any(|a| matches!(a.exact(), Some("status") | Some("show") | Some("list") | Some("list-sessions") | Some("list-timezones") | Some("list-units") | Some("tree") | Some("introspect") | Some("info") | Some("dump") | Some("query") | Some("statistics") | Some("lldp") | Some("monitor")));
                if !read {
                    self.deny(Kind::Privilege, format!("{name} changes the machine's configuration"));
                }
            }
            "journalctl" => {
                if args.iter().any(|a| a.starts("--vacuum") || a.is("--rotate") || a.is("--flush") || a.is("--sync") || a.is("--relinquish-var")) {
                    self.ask(Kind::Destructive, "journalctl deletes or rotates logs");
                }
            }
            "dmesg" => {
                let o = getopt(args, "", &[]);
                if o.has('c') || o.has('C') || o.long("clear") || o.long("read-clear") {
                    self.deny(Kind::Privilege, "dmesg clears the kernel log");
                }
            }
            "ifconfig" => {
                if args.iter().any(|a| matches!(a.exact(), Some("up") | Some("down") | Some("promisc") | Some("-promisc") | Some("add") | Some("del") | Some("netmask") | Some("mtu") | Some("hw")) || a.starts("inet")) {
                    self.deny(Kind::Privilege, "ifconfig changes network configuration");
                }
            }
            "ip" | "ip6" | "iw" | "nmcli" | "tc" | "bridge" | "brctl" | "ethtool" | "wg" | "wg-quick" | "tailscale" | "zerotier-cli" => {
                let mutate = args.iter().any(|a| matches!(a.exact(), Some("add") | Some("del") | Some("delete") | Some("set") | Some("change") | Some("replace") | Some("flush") | Some("append") | Some("save") | Some("restore") | Some("exec") | Some("attach") | Some("connect") | Some("disconnect") | Some("up") | Some("down") | Some("reload") | Some("modify") | Some("create") | Some("remove") | Some("-s_") | Some("addif") | Some("delif") | Some("start") | Some("stop") | Some("login") | Some("logout") | Some("serve") | Some("funnel")));
                if mutate {
                    self.deny(Kind::Privilege, format!("{name} changes network configuration"));
                }
            }
            "iptables" | "ip6tables" | "nft" | "ufw" | "firewall-cmd" | "pfctl" | "iptables-save_" | "ebtables" => {
                let read = args.iter().any(|a| matches!(a.exact(), Some("-L") | Some("-S") | Some("--list") | Some("status") | Some("list") | Some("-s") | Some("--show") | Some("--list-all") | Some("-nvL") | Some("-vnL") | Some("-n") | Some("-v")));
                if !read {
                    self.deny(Kind::Privilege, format!("{name} changes the firewall"));
                }
            }
            "sysctl" => {
                if args.iter().any(|a| a.s.contains('=') || a.is("-w") || a.is("--write") || a.is("-p") || a.is("--load") || a.is("--system")) {
                    self.deny(Kind::Privilege, "sysctl changes kernel settings");
                }
            }
            "crontab" => {
                if !args.iter().any(|a| a.is("-l")) {
                    self.ask(Kind::Write, "crontab changes the scheduled jobs");
                }
            }
            "at" | "batch" | "atrm" => self.ask(Kind::Code, format!("{name} schedules or removes a job")),
            "atq" => {}
            "defaults" => {
                if args.iter().any(|a| matches!(a.exact(), Some("write") | Some("delete") | Some("import") | Some("rename"))) {
                    self.ask(Kind::Write, "defaults changes a preference");
                }
            }
            "launchctl" => {
                if args.iter().any(|a| matches!(a.exact(), Some("load") | Some("unload") | Some("bootstrap") | Some("bootout") | Some("start") | Some("stop") | Some("kickstart") | Some("enable") | Some("disable") | Some("submit") | Some("remove") | Some("kill") | Some("setenv") | Some("unsetenv") | Some("reboot") | Some("asuser") | Some("config") | Some("load-w") | Some("unload-w"))) {
                    self.ask(Kind::Privilege, "launchctl starts, stops or installs a service");
                }
            }
            "diskutil" | "hdiutil" | "tmutil" | "pmset" | "networksetup" | "scutil" | "csrutil" | "spctl" | "nvram" | "dscl" | "sysadminctl" | "systemsetup" | "softwareupdate" | "mdutil" | "profiles" | "security" => {
                if name == "security" {
                    self.deny(Kind::Credential, "security reaches the keychain");
                } else if !args.iter().any(|a| matches!(a.exact(), Some("list") | Some("info") | Some("status") | Some("get") | Some("-get") | Some("-list") | Some("-g") | Some("listallhardwareports") | Some("--help") | Some("read") | Some("-read") | Some("-l") | Some("-s"))) {
                    self.deny(Kind::Privilege, format!("{name} changes the machine's configuration"));
                }
            }
            "xdotool" | "wmctrl" | "xclip" | "xsel" | "pbcopy" | "pbpaste" | "osascript_" | "say" | "afplay" | "notify-send" | "screencapture" | "scrot" | "import" | "grim" | "wl-copy" | "wl-paste" | "xinput" | "xev" | "xset" | "xmodmap" => {
                if matches!(name, "xdotool" | "xinput" | "xev") {
                    self.ask(Kind::Privilege, format!("{name} drives or watches the desktop"));
                } else if matches!(name, "xclip" | "xsel" | "pbpaste" | "wl-paste") {
                    self.ask(Kind::Credential, format!("{name} reads the clipboard, which may hold a secret"));
                } else if matches!(name, "screencapture" | "scrot" | "import" | "grim") {
                    for v in args.iter().filter(|a| !a.starts("-")) {
                        let v = v.clone();
                        self.write_path(&v, st, "saves a screenshot to");
                    }
                }
            }
            _ => return None,
        }
        Some(Out::default())
    }

    fn pure(&mut self, name: &str, args: &[Val], st: &State) {
        let _ = st;
        match name {
            "date" => {
                if args.iter().any(|a| a.is("-s") || a.starts("--set") || (a.starts("-s") && a.s.len() > 2 && !a.starts("-s ") && a.s[2..].chars().next().is_some_and(|c| c.is_ascii_digit()))) {
                    self.deny(Kind::Privilege, "date sets the clock");
                }
            }
            "hostname" => {
                if args.iter().any(|a| !a.starts("-")) && !args.iter().any(|a| matches!(a.exact(), Some("-f") | Some("-s") | Some("-d") | Some("-i") | Some("-I") | Some("-A") | Some("--fqdn"))) {
                    self.deny(Kind::Privilege, "hostname sets the machine's name");
                }
            }
            "stty" | "tput" | "clear" | "reset" => {}
            _ => {}
        }
    }

    /// A command that reads every operand as a file.
    fn reader(&mut self, name: &str, args: &[Val], io: &Io, st: &State) -> Out {
        let with_val = match name {
            "head" | "tail" => "nc",
            "cut" => "dfcb",
            "wc" => "",
            "od" => "AjNtw",
            "xxd" => "slcgo",
            "base64" => "w",
            "column" => "tsceo",
            "fold" => "w",
            "nl" => "bnwslvhfi",
            "paste" => "d",
            "diff" => "LUCIxXFDW",
            "cmp" => "in",
            "less" | "more" => "pPzjtoOhx",
            "bat" | "batcat" => "lrH",
            "strings" => "nTtew",
            "pr" => "wlonh",
            _ => "",
        };
        let o = getopt(args, with_val, &["files0-from", "lines", "bytes", "delimiter", "fields", "width", "separator", "from-file", "style", "language", "theme", "line-range", "pager", "color"]);
        if let Some(p) = o.val("pager") {
            let _ = p;
            self.ask(Kind::Code, format!("{name} runs a pager program"));
        }
        let mut any = false;
        for v in o.all_ops() {
            // `tail -n 5` leaves 5 as a value; numbers are not files.
            self.read_path(v, st, "reads");
            any = true;
        }
        if let Some(f) = o.val("files0-from").or_else(|| o.val("from-file")) {
            let f = f.clone();
            self.read_path(&f, st, "reads");
        }
        if let Stdin::File(f) = &io.stdin {
            let _ = f;
        }
        let net = matches!(io.stdin, Stdin::Pipe { net: true, .. });
        // `cat <<EOF` and `cat file` hand their text on: a here-document made into a script.
        let literal = if name == "cat" && !io.out_file {
            if !any {
                match &io.stdin {
                    Stdin::Text(v) if v.exact().is_some() => Some(v.s.clone()),
                    Stdin::Pipe { literal, .. } => literal.clone(),
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };
        // `cat > script.sh <<EOF`: the text is what the file will hold.
        if name == "cat" && io.out_file && !any {
            let text = match &io.stdin {
                Stdin::Text(v) if v.exact().is_some() => Some(v.s.clone()),
                Stdin::Pipe { literal: Some(t), .. } => Some(t.clone()),
                _ => None,
            };
            if let Some(t) = text {
                self.record_in(io, &t, st);
            }
        }
        Out { literal, net }
    }

    fn grep(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "efmABCdDXOT", &["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-from", "exclude-dir", "label", "binary-files", "devices", "directories", "color", "colour", "pre", "filter", "type", "ignore-file"]);
        if o.val("pre").is_some() || o.val("filter").is_some() {
            self.ask(Kind::Code, format!("{name} runs a program on every file"));
        }
        let patterns_given = o.val("e").is_some() || o.val("regexp").is_some() || o.val("f").is_some() || o.val("file").is_some();
        for key in ["f", "file"] {
            if let Some(f) = o.val(key) {
                let f = f.clone();
                self.read_path(&f, st, "reads patterns from");
            }
        }
        for (i, v) in o.all_ops().enumerate() {
            if i == 0 && !patterns_given {
                continue;
            }
            self.read_path(v, st, "searches");
        }
    }

    fn rg(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "efgmtTABCjMdEr", &["regexp", "file", "glob", "max-count", "type", "type-not", "after-context", "before-context", "context", "threads", "max-columns", "max-depth", "encoding", "ignore-file", "pre", "pre-glob", "type-add", "sort", "sortr", "color", "colors", "path-separator", "replace", "iglob", "engine", "dfa-size-limit", "regex-size-limit", "max-filesize", "field-match-separator", "field-context-separator", "context-separator", "hyperlink-format", "generate", "hostname-bin"]);
        if o.val("pre").is_some() || o.val("hostname-bin").is_some() {
            self.ask(Kind::Code, "rg runs a program on every file");
        }
        let no_pattern = o.long("files") || o.long("type-list") || o.val("e").is_some() || o.val("regexp").is_some() || o.val("f").is_some() || o.val("file").is_some();
        for (i, v) in o.all_ops().enumerate() {
            if i == 0 && !no_pattern {
                continue;
            }
            self.read_path(v, st, "searches");
        }
    }

    fn fd(&mut self, args: &[Val], st: &mut State) {
        let o = getopt(args, "tedxXEoSsHc", &["type", "extension", "exec", "exec-batch", "exclude", "max-depth", "min-depth", "size", "changed-within", "changed-before", "owner", "base-directory", "path-separator", "search-path", "color", "threads", "format"]);
        for key in ["x", "exec", "X", "exec-batch"] {
            if o.long(key) || o.has(key.chars().next().unwrap_or('x')) && key.len() == 1 {
                self.ask(Kind::Code, "fd runs a command on every match");
                break;
            }
        }
        let _ = st;
    }

    fn jq(&mut self, args: &[Val], st: &State) {
        let mut i = 0;
        let mut filter = false;
        let mut files: Vec<&Val> = Vec::new();
        while i < args.len() {
            let a = &args[i];
            i += 1;
            match a.exact() {
                Some("--arg") | Some("--argjson") => i += 2,
                Some("--slurpfile") | Some("--rawfile") => {
                    if let Some(f) = args.get(i + 1) {
                        files.push(f);
                    }
                    i += 2;
                }
                Some("-f") | Some("--from-file") => {
                    if let Some(f) = args.get(i) {
                        files.push(f);
                    }
                    filter = true;
                    i += 1;
                }
                Some("--indent") | Some("--seq_") => i += 1,
                Some("--args") | Some("--jsonargs") => break,
                Some(t) if t.starts_with('-') && t.len() > 1 => {}
                _ => {
                    if filter {
                        files.push(a);
                    } else {
                        filter = true;
                    }
                }
            }
        }
        for f in files {
            self.read_path(f, st, "reads");
        }
    }

    fn yq(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "pPoIfnC", &["input-format", "output-format", "indent", "front-matter", "expression", "from-file"]);
        let inplace = o.has('i') || o.long("inplace");
        let mut ops: Vec<&Val> = o.all_ops().collect();
        if ops.first().is_some_and(|v| matches!(v.exact(), Some("e") | Some("eval") | Some("eval-all") | Some("ea") | Some("shell-completion"))) {
            ops.remove(0);
        }
        if !ops.is_empty() {
            ops.remove(0);
        }
        for f in ops {
            if inplace {
                self.write_path(f, st, "edits in place");
            } else {
                self.read_path(f, st, "reads");
            }
        }
    }

    fn openssl(&mut self, args: &[Val], st: &State) {
        let sub = args.first().and_then(|a| a.exact()).unwrap_or("").to_string();
        if matches!(sub.as_str(), "s_client" | "s_server" | "s_time" | "ocsp" | "ts" | "ciphers_") {
            self.ask(Kind::Network, format!("openssl {sub} opens a network connection"));
            return;
        }
        let mut i = 1;
        while i < args.len() {
            let a = &args[i];
            if let Some(t) = a.exact() {
                match t {
                    "-out" | "-keyout" | "-o" | "-outform_" | "-writerand" | "-CAcreateserial_" => {
                        if let Some(f) = args.get(i + 1) {
                            let f = f.clone();
                            self.write_path(&f, st, "openssl writes");
                        }
                        i += 1;
                    }
                    "-in" | "-inkey" | "-key" | "-cert" | "-CAfile" | "-keyfile" | "-passin_" | "-infile" | "-signature" | "-prverify" | "-verify" | "-pubin_" | "-rand" => {
                        if let Some(f) = args.get(i + 1) {
                            let f = f.clone();
                            if matches!(t, "-inkey" | "-key" | "-keyfile") {
                                self.use_path(&f, st, "reads");
                            } else {
                                self.read_path(&f, st, "reads");
                            }
                        }
                        i += 1;
                    }
                    _ => {}
                }
            }
            i += 1;
        }
    }

    // ----- sed -----

    fn sed(&mut self, args: &[Val], io: &Io, st: &State) {
        let o = getopt(args, "efl", &["expression", "file", "line-length", "separate_"]);
        let inplace = o.has('i') || o.long("in-place") || o.longs.iter().any(|l| l.starts_with("in-place"));
        let mut scripts: Vec<String> = Vec::new();
        let mut script_unknown = false;
        for (n, v) in &o.vals {
            if n == "e" || n == "expression" {
                if v.has_unknown() {
                    script_unknown = true;
                }
                scripts.push(v.s.clone());
            }
            if n == "f" || n == "file" {
                let f = v.clone();
                self.read_path(&f, st, "reads a script from");
            }
        }
        let have_script = !scripts.is_empty() || o.val("f").is_some() || o.val("file").is_some();
        let mut files: Vec<&Val> = o.all_ops().collect();
        if !have_script && !files.is_empty() {
            let s = files.remove(0);
            if s.has_unknown() {
                script_unknown = true;
            }
            scripts.push(s.s.clone());
        }
        for s in &scripts {
            let scan = sed_scan(s);
            if scan.bad {
                if script_unknown {
                    self.ask(Kind::Code, "sed with a script built at runtime");
                } else {
                    self.ask(Kind::Unparsed, "cannot read a sed script");
                }
            }
            if scan.exec {
                self.ask(Kind::Code, "sed runs a command (the e command or flag)");
            }
            for w in scan.writes {
                self.write_path(&Val::lit(w), st, "sed writes");
            }
            for r in scan.reads {
                self.read_path(&Val::lit(r), st, "sed reads");
            }
        }
        for f in files {
            if inplace {
                self.write_path(f, st, "edits in place");
                self.read_path(f, st, "reads");
            } else {
                self.read_path(f, st, "reads");
            }
        }
        let _ = io;
    }

    // ----- awk -----

    fn awk(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "vFfeEiL", &["file", "assign", "field-separator", "source", "include", "load", "exec", "lint"]);
        if o.val("L").is_some() {
            return;
        }
        let mut ops: Vec<&Val> = o.all_ops().collect();
        let progs: Vec<&Val> = o.vals.iter().filter(|(n, _)| n == "f" || n == "file").map(|(_, v)| v).collect();
        for f in &progs {
            let f = (*f).clone();
            self.read_path(&f, st, "reads a program from");
        }
        let mut program: Option<&Val> = None;
        for (n, v) in &o.vals {
            if n == "e" || n == "source" {
                program = Some(v);
            }
        }
        if progs.is_empty() && program.is_none() && !ops.is_empty() {
            program = Some(ops.remove(0));
        }
        if o.has('i') || o.long("include") || o.long("load") {
            if o.val("i").is_some_and(|v| v.is("inplace")) {
                for f in &ops {
                    self.write_path(f, st, "edits in place");
                }
                ops.clear();
            } else {
                self.ask(Kind::Code, format!("{name} loads an extension"));
            }
        }
        if let Some(p) = program {
            if p.has_unknown() {
                self.ask(Kind::Code, format!("{name} with a program built at runtime"));
            }
            match awk_scan(&p.s) {
                Awk::Fine => {}
                Awk::Runs => self.ask(Kind::Code, format!("{name} runs a command (system, a pipe or getline from a command)")),
                Awk::Writes(files) => {
                    if files.is_empty() {
                        self.ask(Kind::Write, format!("{name} writes to a file it cannot name"));
                    }
                    for f in files {
                        self.write_path(&Val::lit(f), st, "awk writes");
                    }
                }
                Awk::Unreadable => self.ask(Kind::Unparsed, format!("cannot read an {name} program")),
            }
        }
        for f in ops {
            self.read_path(f, st, "reads");
        }
    }

    // ----- find -----

    fn find(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let mut i = 0;
        let mut roots: Vec<Val> = Vec::new();
        while i < args.len() {
            let a = &args[i];
            match a.exact() {
                Some("-H") | Some("-L") | Some("-P") | Some("-E") | Some("-X") | Some("-d") | Some("-x") | Some("-s") | Some("-f") if a.exact().is_some() && roots.is_empty() && !a.is("-f") => i += 1,
                Some(t) if t.starts_with('-') || t == "(" || t == "!" || t == "," || t == ")" => break,
                _ => {
                    roots.push(a.clone());
                    i += 1;
                }
            }
        }
        if roots.is_empty() {
            roots.push(Val::lit("."));
        }
        let expr = &args[i.min(args.len())..];
        let outside = roots.iter().any(|r| !matches!(self.sense(r, st).place, Place::Work | Place::Anchor | Place::Temp | Place::TempRoot));
        let mut k = 0;
        while k < expr.len() {
            let t = expr[k].exact().unwrap_or("");
            match t {
                "-delete" => {
                    if outside {
                        self.deny(Kind::Destructive, "find -delete outside the workspace");
                    } else {
                        self.ask(Kind::Destructive, "find -delete removes every file it matches");
                    }
                }
                "-fprint" | "-fprint0" | "-fprintf" | "-fls" => {
                    if let Some(f) = expr.get(k + 1) {
                        let f = f.clone();
                        self.write_path(&f, st, "find writes");
                    }
                    k += 1;
                }
                "-exec" | "-execdir" | "-ok" | "-okdir" => {
                    let mut inner: Vec<Val> = Vec::new();
                    let mut j = k + 1;
                    while j < expr.len() {
                        let w = &expr[j];
                        if w.is(";") || w.is("+") {
                            break;
                        }
                        inner.push(w.clone());
                        j += 1;
                    }
                    k = j;
                    if inner.is_empty() {
                        k += 1;
                        continue;
                    }
                    let first = roots.first().cloned().unwrap_or_else(|| Val::lit("."));
                    let placeholder = Val { s: format!("{}/{}", first.s.trim_end_matches('/'), UNK), glob: false, split: false };
                    let inner: Vec<Val> = inner.into_iter().map(|w| if w.is("{}") { placeholder.clone() } else { w }).collect();
                    let name = inner[0].exact().map(|n| n.rsplit('/').next().unwrap_or(n).to_string());
                    let destructive = matches!(name.as_deref(), Some("rm") | Some("rmdir") | Some("unlink") | Some("shred") | Some("mv") | Some("truncate") | Some("srm"));
                    if destructive {
                        if outside {
                            self.deny(Kind::Destructive, "find runs a destructive command on files outside the workspace");
                        } else {
                            self.ask(Kind::Destructive, "find runs a destructive command on every match");
                        }
                    }
                    let mut s = st.clone();
                    self.run(inner, &[], io, &mut s);
                }
                _ => {}
            }
            k += 1;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// sed

#[derive(Default)]
pub(crate) struct SedScan {
    pub exec: bool,
    pub writes: Vec<String>,
    pub reads: Vec<String>,
    pub bad: bool,
}

pub(crate) fn sed_scan(script: &str) -> SedScan {
    let mut out = SedScan::default();
    let c: Vec<char> = script.chars().collect();
    let mut i = 0;
    let n = c.len();
    let rest_of_line = |i: &mut usize| -> String {
        let start = *i;
        while *i < n && c[*i] != '\n' {
            *i += 1;
        }
        c[start..*i].iter().collect::<String>().trim().to_string()
    };
    // Skips to the delimiter that ends a part, honouring `\` escapes; false if it never comes.
    let part = |i: &mut usize, d: char| -> bool {
        while *i < n {
            if c[*i] == '\\' {
                *i += 2;
                continue;
            }
            if c[*i] == d {
                *i += 1;
                return true;
            }
            *i += 1;
        }
        false
    };
    while i < n {
        while i < n && (c[i].is_whitespace() || c[i] == ';' || c[i] == '{' || c[i] == '}') {
            i += 1;
        }
        if i >= n {
            break;
        }
        // An address: numbers, `$`, `/re/`, `\cREc`, `first~step`, ranges, `!`.
        loop {
            while i < n && c[i] == ' ' {
                i += 1;
            }
            if i < n && (c[i].is_ascii_digit() || c[i] == '$' || c[i] == '~' || c[i] == '+' || c[i] == crate::val::UNK) {
                i += 1;
                continue;
            }
            if i < n && c[i] == '/' {
                i += 1;
                if !part(&mut i, '/') {
                    out.bad = true;
                    return out;
                }
                while i < n && (c[i] == 'I' || c[i] == 'M') {
                    i += 1;
                }
                continue;
            }
            if i < n && c[i] == '\\' && i + 1 < n {
                let d = c[i + 1];
                i += 2;
                if !part(&mut i, d) {
                    out.bad = true;
                    return out;
                }
                continue;
            }
            if i < n && (c[i] == ',' || c[i] == '!') {
                i += 1;
                continue;
            }
            break;
        }
        if i >= n {
            break;
        }
        let cmd = c[i];
        i += 1;
        match cmd {
            's' => {
                let Some(&d) = c.get(i) else {
                    out.bad = true;
                    return out;
                };
                i += 1;
                if !part(&mut i, d) || !part(&mut i, d) {
                    out.bad = true;
                    return out;
                }
                while i < n {
                    match c[i] {
                        'e' | 'E' => {
                            out.exec = true;
                            i += 1;
                        }
                        'w' => {
                            i += 1;
                            let f = rest_of_line(&mut i);
                            if !f.is_empty() && f != "/dev/stdout" && f != "/dev/stderr" {
                                out.writes.push(f);
                            }
                        }
                        'g' | 'p' | 'i' | 'I' | 'm' | 'M' | '0'..='9' => i += 1,
                        _ => break,
                    }
                }
            }
            'y' => {
                let Some(&d) = c.get(i) else {
                    out.bad = true;
                    return out;
                };
                i += 1;
                if !part(&mut i, d) || !part(&mut i, d) {
                    out.bad = true;
                    return out;
                }
            }
            'w' | 'W' => {
                let f = rest_of_line(&mut i);
                if !f.is_empty() && f != "/dev/stdout" && f != "/dev/stderr" {
                    out.writes.push(f);
                }
            }
            'r' | 'R' => {
                let f = rest_of_line(&mut i);
                if !f.is_empty() {
                    out.reads.push(f);
                }
            }
            'e' => {
                out.exec = true;
                rest_of_line(&mut i);
            }
            'a' | 'i' | 'c' => {
                // Text to the end of the line; a trailing backslash continues it.
                loop {
                    while i < n && c[i] != '\n' {
                        if c[i] == '\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                    if i >= 1 && i <= n && i > 0 && c.get(i - 1) == Some(&'\\') && i < n {
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            ':' | 'b' | 't' | 'T' => {
                while i < n && c[i] != ';' && c[i] != '\n' && c[i] != '}' {
                    i += 1;
                }
            }
            '#' => {
                rest_of_line(&mut i);
            }
            'q' | 'Q' | 'l' | 'L' => {
                while i < n && c[i].is_ascii_digit() {
                    i += 1;
                }
            }
            '=' | 'd' | 'D' | 'g' | 'G' | 'h' | 'H' | 'n' | 'N' | 'p' | 'P' | 'x' | 'z' | 'F' => {}
            _ => {
                out.bad = true;
                return out;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// awk

pub(crate) enum Awk {
    Fine,
    Runs,
    Writes(Vec<String>),
    Unreadable,
}

/// Whether an awk program runs commands or writes files: `system()`, a pipe, `getline` from
/// a command, `print > file`.
pub(crate) fn awk_scan(prog: &str) -> Awk {
    let c: Vec<char> = prog.chars().collect();
    let n = c.len();
    let mut i = 0;
    let mut prev_operand = false;
    let mut in_print = false;
    let mut depth = 0i32;
    let mut writes: Vec<String> = Vec::new();
    let mut runs = false;
    let mut unreadable = false;
    while i < n {
        let ch = c[i];
        match ch {
            '#' => {
                while i < n && c[i] != '\n' {
                    i += 1;
                }
            }
            '"' => {
                i += 1;
                while i < n && c[i] != '"' {
                    if c[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                if i >= n {
                    unreadable = true;
                }
                i += 1;
                prev_operand = true;
            }
            '/' if !prev_operand => {
                // A regular expression literal.
                i += 1;
                while i < n && c[i] != '/' {
                    if c[i] == '\\' {
                        i += 1;
                    }
                    if i < n && c[i] == '[' {
                        while i < n && c[i] != ']' {
                            i += 1;
                        }
                    }
                    i += 1;
                }
                i += 1;
                prev_operand = true;
            }
            '(' => {
                depth += 1;
                i += 1;
                prev_operand = false;
            }
            ')' => {
                depth -= 1;
                i += 1;
                prev_operand = true;
            }
            ';' | '}' | '{' | '\n' => {
                in_print = false;
                depth = 0;
                i += 1;
                prev_operand = false;
            }
            '|' => {
                if c.get(i + 1) == Some(&'|') {
                    i += 2;
                } else {
                    runs = true;
                    i += 1;
                }
                prev_operand = false;
            }
            '>' => {
                if in_print && depth == 0 {
                    let mut j = i + 1;
                    if c.get(j) == Some(&'>') {
                        j += 1;
                    }
                    while j < n && c[j] == ' ' {
                        j += 1;
                    }
                    if c.get(j) == Some(&'"') {
                        let mut k = j + 1;
                        let mut f = String::new();
                        while k < n && c[k] != '"' {
                            f.push(c[k]);
                            k += 1;
                        }
                        writes.push(f);
                    } else {
                        writes.push(String::new());
                    }
                }
                i += 1;
                prev_operand = false;
            }
            c0 if c0.is_alphabetic() || c0 == '_' => {
                let start = i;
                while i < n && (c[i].is_alphanumeric() || c[i] == '_') {
                    i += 1;
                }
                let w: String = c[start..i].iter().collect();
                match w.as_str() {
                    "system" => {
                        let mut j = i;
                        while j < n && c[j] == ' ' {
                            j += 1;
                        }
                        if c.get(j) == Some(&'(') {
                            runs = true;
                        }
                    }
                    "print" | "printf" => in_print = true,
                    "getline" => {}
                    "ENVIRON_" => {}
                    _ => {}
                }
                prev_operand = true;
            }
            c0 if c0.is_ascii_digit() || c0 == '.' || c0 == '$' => {
                i += 1;
                prev_operand = true;
            }
            _ => {
                i += 1;
                prev_operand = false;
            }
        }
    }
    if unreadable {
        Awk::Unreadable
    } else if runs {
        Awk::Runs
    } else if !writes.is_empty() {
        Awk::Writes(writes.into_iter().filter(|w| w != "/dev/stdout" && w != "/dev/stderr" && w != "/dev/null").collect::<Vec<_>>()).into_fine_if_empty()
    } else {
        Awk::Fine
    }
}

impl Awk {
    fn into_fine_if_empty(self) -> Awk {
        match self {
            Awk::Writes(v) if v.is_empty() => Awk::Fine,
            other => other,
        }
    }
}

#[allow(dead_code)]
fn unused(_: Opts) {}
