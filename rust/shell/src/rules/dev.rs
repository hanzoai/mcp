//! Build, test, package and task tools: what is allowed in a project and what leaves it.

// Rule tables name a verb under its group and again under any group; the first arm that matches decides.
#![allow(unreachable_patterns)]

use super::getopt;
use crate::path::Place;
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Walker};

/// Compilers, test runners, linters and formatters: they read the project and write to it.
const TOOLS: &[&str] = &[
    "gcc", "g++", "cc", "c++", "clang", "clang++", "cpp", "tcc", "ld", "lld", "gold", "as", "ar", "ranlib", "nm_", "strip", "objcopy", "pkg-config", "ccache", "sccache", "rustc", "rustfmt", "rustdoc", "clippy-driver", "cargo-clippy", "cargo-fmt", "javac", "javadoc", "jar", "kotlinc", "scalac", "sbt", "ghc", "cabal", "stack", "nim", "crystal",
    "swiftc", "zig", "dotnet_", "tsc", "tsx", "ts-node", "esbuild", "vite", "webpack", "rollup", "parcel", "next", "nuxt", "astro", "svelte-kit", "turbo", "nx", "lerna", "jest", "vitest", "mocha", "ava", "karma", "cypress", "eslint", "prettier", "biome", "oxlint", "stylelint", "sass", "tailwindcss", "postcss", "babel", "swc", "terser", "pytest", "py.test", "tox", "nox", "mypy", "pyright", "pyflakes",
    "flake8", "pylint", "ruff", "black", "isort", "bandit", "autopep8", "yapf", "pycodestyle", "pydocstyle", "coverage", "gofmt", "goimports", "gopls", "golangci-lint", "staticcheck", "govulncheck", "ginkgo", "gotestsum", "mockgen", "protoc", "buf", "sqlc", "air", "shellcheck", "shfmt", "hadolint", "markdownlint", "yamllint", "taplo", "actionlint", "typos", "codespell", "cargo-nextest",
    "cargo-llvm-cov", "cargo-deny", "cargo-audit", "cargo-udeps", "cargo-expand", "cargo-machete", "cargo-outdated", "cargo-license", "cargo-zigbuild", "cargo-hack", "cargo-semver-checks", "tokei", "cloc", "scc", "hyperfine", "wasm-bindgen", "wasm-pack", "wasm-opt", "wasm2wat", "wat2wasm", "wasm2es6js", "wasm-bindgen-test-runner", "cmake_", "ctest", "cpack", "meson_", "ninja_", "bazel_", "pre-commit", "lefthook", "husky", "lint-staged",
    "docker-compose_", "storybook", "nodemon", "serve", "http-server", "tsc-alias", "vue-tsc", "svelte-check", "knip", "depcheck", "madge", "size-limit", "markdownlint-cli2", "ts-node-dev", "zx", "tsup", "unbuild", "wrangler_", "elm", "purs", "spago", "dune", "opam_", "ocamlfind", "ocamlc", "ocamlopt", "rebar3_", "mix_", "lein_", "gleam_", "v", "odin",
];
/// Task runners: they run what the project says, and a target named for a release is one.
const RUNNERS: &[&str] = &["make", "gmake", "cmake", "ninja", "meson", "bazel", "bazelisk", "just", "task", "rake", "scons", "ant", "gradle", "mvn"];
const RELEASE: &[&str] = &["deploy", "publish", "release", "push", "upload", "install", "uninstall", "apply", "destroy", "provision", "rollout", "promote", "ship", "prod", "production", "migrate", "rollback", "tag", "sign", "distribute"];

impl Walker<'_> {
    pub(crate) fn dev_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        if TOOLS.contains(&name) {
            self.build_tool(name, args, st);
            return Some(Out::default());
        }
        if RUNNERS.contains(&name) || name == "gradlew" || name == "mvnw" || name == "./gradlew" {
            self.runner(name, args, st);
            return Some(Out::default());
        }
        match name {
            "cargo" => self.cargo(args, io, st),
            "go" => self.go(args, io, st),
            "npm" | "pnpm" | "yarn" | "bun_" | "pnpx" | "yarnpkg" | "corepack_" => self.node_pm(name, args, io, st),
            "npx" | "bunx" | "pnpx" | "uvx" | "pipx" => self.fetch_run(name, args, io, st),
            "pip" | "pip3" => self.dev_pip(args, st),
            "uv" => self.uv(args, io, st),
            "poetry" | "pdm" | "pipenv" | "hatch" | "rye" | "conda" | "mamba" | "micromamba" | "mise" | "rtx" | "asdf" | "direnv" | "devbox" | "nix-shell" | "nix" | "volta" | "fnm" | "nvm" | "pyenv" | "rbenv" | "rustup" | "bundle" | "gem" | "composer" | "dotnet" | "nuget" | "brew" => self.env_manager(name, args, io, st),
            "rimraf" => {
                let o = getopt(args, "", &["glob"]);
                for v in o.all_ops() {
                    self.remove_path(v, st, true);
                }
            }
            "cross-env" | "dotenv" | "env-cmd" | "dotenvx" => {
                let skip = args.iter().position(|a| !a.s.contains('=') && !a.starts("-")).unwrap_or(args.len());
                for a in &args[..skip] {
                    if let Some((n, v)) = a.s.split_once('=') {
                        super::env_name(self, n, &[Val::lit(v)]);
                    }
                }
                let rest = args[skip..].to_vec();
                if name != "cross-env" {
                    self.ask(Kind::Credential, format!("{name} loads secrets from a file into the command"));
                }
                if !rest.is_empty() {
                    self.run(rest, &[], io, st);
                }
            }
            "concurrently" | "npm-run-all" | "run-p" | "run-s" | "npm-run-all2" => {
                for a in args.iter().filter(|a| !a.starts("-")) {
                    if name == "concurrently" {
                        let a = a.clone();
                        self.nested_string(&a, st, "concurrently");
                    }
                }
            }
            "corepack" => {
                let sub = args.iter().find(|a| !a.starts("-")).and_then(|a| a.exact()).unwrap_or("").to_string();
                match sub.as_str() {
                    "enable" | "disable" | "install" | "prepare" | "pack" | "use" | "up" | "cache" => self.ask(Kind::Write, format!("corepack {sub} changes the installed package managers")),
                    "pnpm" | "yarn" | "npm" | "pnpx" | "yarnpkg" => {
                        let at = args.iter().position(|a| a.exact() == Some(sub.as_str())).unwrap_or(0);
                        let rest = args[at..].to_vec();
                        self.run(rest, &[], io, st);
                    }
                    _ => {}
                }
            }
            "playwright" => {
                let sub = args.iter().find(|a| !a.starts("-")).and_then(|a| a.exact()).unwrap_or("").to_string();
                match sub.as_str() {
                    "install" | "install-deps" | "uninstall" => self.ask(Kind::Write, format!("playwright {sub} changes the installed browsers")),
                    "open" | "codegen" | "screenshot" | "pdf" | "cr" | "ff" | "wk" => {
                        let o = getopt(args, "o", &["output", "save-storage", "load-storage", "save-har"]);
                        for k in ["o", "output", "save-storage", "save-har"] {
                            if let Some(f) = o.val(k) {
                                let f = f.clone();
                                self.write_path(&f, st, "playwright writes");
                            }
                        }
                    }
                    _ => {}
                }
            }
            "rustc_" => {}
            _ => return None,
        }
        Some(Out::default())
    }

    fn build_tool(&mut self, name: &str, args: &[Val], st: &State) {
        let o = getopt(args, "oIlLDJ", &["output", "out-dir", "outdir", "out-file", "outfile", "target-dir", "dist-dir", "output-dir", "cache-dir", "coverage-dir", "write", "config"]);
        for k in ["o", "output", "out-dir", "outdir", "out-file", "outfile", "target-dir", "dist-dir", "output-dir", "coverage-dir"] {
            if let Some(v) = o.val(k) {
                let v = v.clone();
                if v.s != "-" && !v.s.is_empty() {
                    self.write_path(&v, st, &format!("{name} writes"));
                }
            }
        }
        if name == "strip" || name == "objcopy" {
            for v in o.all_ops() {
                self.write_path(v, st, "modifies");
            }
        }
        if matches!(name, "pre-commit" | "lefthook" | "husky") && o.ops.first().is_some_and(|v| matches!(v.exact(), Some("install") | Some("install-hooks") | Some("uninstall"))) {
            self.ask(Kind::Write, format!("{name} installs git hooks, which run on later git commands"));
        }
        if name == "wasm-pack" && o.ops.first().is_some_and(|v| v.is("publish")) {
            self.ask(Kind::Publishing, "wasm-pack publish releases a package");
        }
        if matches!(name, "playwright") && o.ops.first().is_some_and(|v| v.is("install")) {
            self.ask(Kind::Write, "installs browsers outside the workspace");
        }
    }

    fn runner(&mut self, name: &str, args: &[Val], st: &mut State) {
        let o = getopt(args, "CfFjlLoOpsSBDdewEIcnT", &["directory", "file", "makefile", "jobs", "project-dir", "build-file", "settings-file", "install-prefix", "prefix", "config", "log-file", "cwd", "dir", "buildfile", "taskfile", "justfile", "working-directory", "output_base", "output_user_root", "source-dir", "build-dir", "target", "toolchain", "preset", "workflow", "build"]);
        // Where the tool works and what it writes there.
        let dir = o.val("C").or_else(|| o.val("directory")).or_else(|| o.val("project-dir")).or_else(|| o.val("dir")).or_else(|| o.val("cwd")).or_else(|| o.val("working-directory")).or_else(|| o.val("source-dir")).or_else(|| o.val("build-dir"));
        if let Some(d) = dir {
            let d = d.clone();
            self.write_path(&d, st, &format!("{name} builds in"));
        }
        if name == "cmake" && (o.long("install") || o.long("build_")) {
            if o.long("install") {
                self.ask(Kind::Write, "cmake --install copies files into the install prefix");
            }
        }
        let targets: Vec<&Val> = o.ops.iter().collect();
        for t in targets {
            if let Some(n) = t.exact() {
                let low = n.to_ascii_lowercase();
                let base = low.rsplit(['/', ':']).next().unwrap_or(&low);
                if RELEASE.iter().any(|r| base == *r || base.starts_with(&format!("{r}-")) || base.starts_with(&format!("{r}_")) || base.ends_with(&format!("-{r}")) || base.ends_with(&format!("_{r}")) || base.starts_with(&format!("{r}:"))) {
                    let kind = if matches!(base.split(['-', '_']).next().unwrap_or(""), "install" | "uninstall") { Kind::Write } else { Kind::Publishing };
                    self.ask(kind, format!("{name} {n} is a target that ships or installs"));
                }
            }
        }
        if let Some(v) = o.val("o") {
            let _ = v;
        }
    }

    fn cargo(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let mut i = 0;
        // Global options before the subcommand: `+nightly`, `--config`, `-Z`, `-C dir`.
        while i < args.len() {
            let t = args[i].exact().unwrap_or("");
            if t.starts_with('+') {
                i += 1;
            } else if t == "--config" || t == "-Z" || t == "--color" || t == "--manifest-path" || t == "-C" {
                if t == "--config" {
                    if let Some(c) = args.get(i + 1) {
                        self.ask_cargo_config(c);
                    }
                }
                i += 2;
            } else if t.starts_with("--config=") {
                let c = Val::lit(t["--config=".len()..].to_string());
                self.ask_cargo_config(&c);
                i += 1;
            } else if t.starts_with('-') {
                i += 1;
            } else {
                break;
            }
        }
        let Some(sub) = args.get(i).and_then(|a| a.exact()).map(str::to_string) else {
            return;
        };
        let rest = &args[i + 1..];
        let before_dd = rest.iter().position(|a| a.is("--")).unwrap_or(rest.len());
        let o = getopt(&rest[..before_dd], "pPjFZCxqvehnmt", &["manifest-path", "target-dir", "package", "bin", "example", "test", "bench", "features", "target", "profile", "config", "jobs", "color", "message-format", "root", "index", "registry", "token", "path", "git", "branch", "tag", "rev", "version", "vers", "name", "lib", "edition", "vcs", "out-dir", "artifact-dir", "exclude", "lockfile-path", "locked_", "toolchain", "output", "width"]);
        for k in ["target-dir", "out-dir", "artifact-dir"] {
            if let Some(d) = o.val(k) {
                let d = d.clone();
                self.write_path(&d, st, "cargo writes");
            }
        }
        if let Some(c) = o.val("config") {
            let c = c.clone();
            self.ask_cargo_config(&c);
        }
        if let Some(m) = o.val("manifest-path") {
            let m = m.clone();
            let dir = match m.s.rfind('/') {
                Some(k) => Val::lit(m.s[..=k].to_string()),
                None => Val::lit("./"),
            };
            self.write_path(&dir, st, "cargo builds in");
        }
        match sub.as_str() {
            "build" | "b" | "check" | "c" | "test" | "t" | "clippy" | "fmt" | "doc" | "d" | "bench" | "run" | "r" | "clean" | "tree" | "metadata" | "fetch" | "update" | "add" | "remove" | "rm" | "vendor" | "package" | "search" | "info" | "nextest" | "llvm-cov" | "deny" | "license" | "zigbuild" | "expand" | "audit" | "outdated" | "udeps" | "bloat" | "flamegraph" | "miri" | "fix" | "rustc" | "rustdoc" | "verify-project" | "locate-project" | "pkgid" | "read-manifest" | "version" | "help" | "config" | "init" | "new" | "generate-lockfile" | "report" | "set-version" | "upgrade" | "xtask" | "make" | "hack" | "machete" | "semver-checks" | "insta" | "criterion" | "tarpaulin" | "geiger" | "bininstall_" | "sort" | "msrv" | "show-asm" | "asm" | "depgraph" | "modules" | "deps" | "workspaces" | "edit" | "readme" | "rdme" | "about" | "sweep" | "cache" | "cache-clean_" | "nextest-run_" | "fuzz" | "afl" | "mutants" | "public-api" | "release-plz_" | "dist" | "component_" | "wasm" | "leptos" | "tauri" | "bundle" | "pgrx" | "shuttle_" | "web_" | "script" | "binstall_" | "tree-sitter_" | "deadlinks" | "spellcheck" | "diet" | "unmaintained" | "supply-chain" | "vet" | "auditable" | "cyclonedx" | "sbom" | "lichking" | "valgrind" | "crev" | "spdx" => {
                if sub == "clean" && (o.long("target-dir") || o.val("target-dir").is_some()) {
                    // handled by the write check above
                }
                if sub == "add" || sub == "remove" || sub == "rm" || sub == "update" || sub == "fetch" || sub == "vendor" {
                    // edits Cargo.toml / downloads: workspace
                }
                if sub == "vendor" {
                    if let Some(d) = o.ops.first() {
                        let d = d.clone();
                        self.write_path(&d, st, "cargo vendor writes");
                    }
                }
                if sub == "package" && o.long("allow-dirty_") {}
            }
            "install" | "uninstall" => {
                match o.val("root") {
                    Some(r) => {
                        let r = r.clone();
                        self.write_path(&r, st, "cargo installs into");
                    }
                    None => self.ask(Kind::Write, format!("cargo {sub} changes the programs in the person's cargo bin directory")),
                }
            }
            "publish" => {
                if !(o.long("dry-run") || o.has('n')) {
                    self.ask(Kind::Publishing, "cargo publish releases a crate");
                }
            }
            "login" | "logout" | "owner" | "yank" => self.ask(Kind::Publishing, format!("cargo {sub} changes a registry account or release")),
            "watch" => {
                for (n, v) in &o.vals {
                    if n == "s" || n == "shell" {
                        let v = v.clone();
                        self.nested_string(&v, st, "cargo watch -s");
                    }
                }
                if let Some(pos) = rest.iter().position(|a| a.is("-s") || a.is("--shell")) {
                    if let Some(c) = rest.get(pos + 1) {
                        let c = c.clone();
                        self.nested_string(&c, st, "cargo watch -s");
                    }
                }
            }
            other => {
                // `cargo foo` runs the program `cargo-foo` from the path.
                self.ask(Kind::Unknown, format!("cargo-{other} is an external subcommand"));
            }
        }
        let _ = io;
    }

    fn ask_cargo_config(&mut self, c: &Val) {
        let low = c.s.to_ascii_lowercase();
        if low.contains("rustc-wrapper") || low.contains("runner") || low.contains("linker") || low.contains("rustc-workspace-wrapper") || low.contains("rustflags") || low.contains("alias.") || low.contains("registry") || low.contains("credential") || low.contains("rustc =") || low.contains("rustc=") || low.contains("build.target") && false {
            self.ask(Kind::Code, "cargo --config sets a program that runs during the build");
        } else if !low.contains("=") && !c.starts("/") {
            // A path to a config file is read as one.
        }
    }

    fn go(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let _ = io;
        let sub = match args.iter().find(|a| !a.starts("-")).and_then(|a| a.exact()) {
            Some(s) => s.to_string(),
            None => return,
        };
        let pos = args.iter().position(|a| a.exact() == Some(sub.as_str())).unwrap_or(0);
        let rest = &args[pos + 1..];
        let o = getopt(rest, "oCpvxcP", &["exec", "toolexec", "overlay", "modfile", "pkgdir", "asmflags", "gcflags", "ldflags", "tags", "mod", "coverprofile", "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "outputdir", "run", "bench", "timeout", "count", "parallel", "cpu", "fuzz", "fuzztime", "shuffle", "json_"]);
        if o.val("exec").is_some() || o.val("toolexec").is_some() {
            self.ask(Kind::Code, format!("go {sub} runs a program the flags name"));
        }
        for k in ["o", "coverprofile", "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "outputdir"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                self.write_path(&f, st, "go writes");
            }
        }
        match sub.as_str() {
            "build" | "test" | "vet" | "fmt" | "mod" | "list" | "env" | "version" | "doc" | "generate" | "fix" | "tool" | "work" | "telemetry" | "help" | "get" | "bug_" => {
                if sub == "env" && (o.has('w') || o.has('u')) {
                    self.ask(Kind::Write, "go env -w changes the person's go configuration");
                }
                if sub == "get" || sub == "mod" {
                    // Edits go.mod and downloads modules.
                }
                if sub == "test" || sub == "build" {
                    // -exec handled above
                }
            }
            "run" => {
                if o.ops.first().is_some_and(|v| v.s.contains('@')) {
                    self.ask(Kind::Network, "go run runs a module version fetched from the network");
                }
            }
            "clean" => {
                if o.has('m') || o.long("modcache") || o.long("cache") || o.long("fuzzcache") || o.long("testcache_") {
                    self.ask(Kind::Destructive, "go clean deletes the shared module or build cache");
                }
            }
            "install" => self.ask(Kind::Write, "go install writes programs into the person's go bin directory"),
            other => self.ask(Kind::Unknown, format!("unknown go subcommand: {other}")),
        }
    }

    fn node_pm(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        let o = getopt(args, "C", &["prefix", "cwd", "dir", "workspace", "filter", "registry", "userconfig", "globalconfig", "cache", "tag", "otp", "access", "scope", "loglevel", "reporter", "config"]);
        let global = o.has('g') || o.long("global") || o.long("location=global");
        if let Some(d) = o.val("prefix").or_else(|| o.val("cwd")).or_else(|| o.val("dir")).or_else(|| o.val("C")) {
            let d = d.clone();
            self.write_path(&d, st, &format!("{name} works in"));
        }
        let Some(sub) = o.ops.first().and_then(|v| v.exact()).map(str::to_string) else { return };
        let rest: Vec<Val> = o.ops.iter().skip(1).cloned().chain(o.after.iter().cloned()).collect();
        let writes_global = matches!(sub.as_str(), "install" | "i" | "add" | "remove" | "rm" | "uninstall" | "un" | "update" | "up" | "upgrade" | "link" | "ln" | "unlink" | "install-test" | "it" | "global");
        if global && writes_global {
            self.ask(Kind::Write, format!("{name} {sub} -g changes the global packages"));
        }
        if sub == "global" {
            self.ask(Kind::Write, format!("{name} global changes the global packages"));
        }
        match sub.as_str() {
            "publish" | "unpublish" | "deprecate" | "owner" | "access" | "team" | "org" | "hook" | "star" | "unstar" | "stars" | "dist-tag" | "set-script_" | "profile" | "sbom_" => {
                let dry = o.long("dry-run");
                if !dry && !matches!(sub.as_str(), "stars") {
                    self.ask(Kind::Publishing, format!("{name} {sub} changes a registry package or account"));
                }
            }
            "login" | "logout" | "adduser" | "token" | "whoami_" | "signin" => self.ask(Kind::Credential, format!("{name} {sub} reads or changes the registry login")),
            "config" | "set" | "c" => {
                let verb = rest.first().and_then(|v| v.exact()).unwrap_or("");
                if matches!(verb, "get" | "list" | "ls" | "l" | "") && sub != "set" {
                    // reading settings
                } else {
                    self.ask(Kind::Write, format!("{name} {sub} changes the person's configuration"));
                }
            }
            "dlx" | "exec" | "x" | "create" | "init_" | "innit_" => {
                if (sub == "exec" || sub == "x") && !o.long("no-install") {
                    // `pnpm exec X`, `npm exec -- X`: a local binary.
                    let inner: Vec<Val> = rest.clone();
                    if !inner.is_empty() {
                        let mut s = st.clone();
                        self.run(inner, &[], io, &mut s);
                    }
                } else {
                    self.ask(Kind::Network, format!("{name} {sub} runs a package fetched from the network"));
                }
            }
            "run" | "run-script" | "rum" | "urn" | "test" | "t" | "tst" | "start" | "stop" | "restart" | "build" | "dev" | "lint" | "format" | "typecheck" | "check" | "install" | "i" | "ci" | "add" | "remove" | "rm" | "uninstall" | "update" | "up" | "upgrade" | "outdated" | "list" | "ls" | "ll" | "la" | "audit" | "version" | "view" | "info" | "show" | "search" | "prefix" | "root" | "bin" | "explain" | "why" | "pack" | "init" | "link" | "unlink" | "rebuild" | "dedupe" | "prune" | "cache" | "fund" | "help" | "doctor" | "ping" | "install-test" | "it" | "find-dupes" | "edit_" | "repo" | "docs" | "bugs" | "home" | "completion" | "diff" | "query" | "pkg" | "fetch" | "store" | "licenses" | "env" | "patch" | "patch-commit" | "import" | "approve-builds" | "deploy" | "recursive" | "multi" | "m" | "workspaces" | "workspace" | "filter" | "up-to-date_" | "bundle" | "node" | "constraints" | "plugin" | "set-version_" | "tag_" | "unplug" | "npm" | "run-p" | "run-s" | "exec_" | "x_" | "xx_" | "pm" | "upgrade-interactive" | "create_" | "-v" | "--version" | "--help" | "-h" | "v" => {
                if sub == "cache" && rest.first().is_some_and(|v| matches!(v.exact(), Some("clean") | Some("rm"))) {
                    self.ask(Kind::Destructive, format!("{name} cache clean deletes the shared package cache"));
                }
                if matches!(sub.as_str(), "deploy" | "bundle") && name == "pnpm" {
                    // pnpm deploy copies a package: workspace.
                }
            }
            other => {
                // pnpm, yarn and bun run an unknown word as a script or a binary of the project.
                if name == "npm" && !other.starts_with('-') {
                    self.ask(Kind::Unknown, format!("unknown npm subcommand: {other}"));
                }
            }
        }
    }

    /// `npx`, `bunx`, `uvx`, `pipx run`: a package from the network, run.
    fn fetch_run(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        let o = getopt(args, "pcCwrs", &["package", "call", "cache", "workspace", "node-arg", "yes_"]);
        // A well-known development tool, by its own name: the project's copy runs, and the
        // registry's only when there is none.
        if matches!(name, "npx" | "bunx" | "pnpx") && o.val("p").is_none() && o.val("package").is_none() && o.val("c").is_none() && o.val("call").is_none() {
            let skip = super::wrap::skip_opts(args, "pcCwrs", &["package", "call", "cache", "workspace", "node-arg"]);
            if let Some(tool) = args.get(skip).and_then(|v| v.exact()) {
                let bare = match tool.rfind('@') {
                    Some(i) if i > 0 => &tool[..i],
                    _ => tool,
                };
                let cmd = match bare {
                    "@playwright/test" => Some("playwright"),
                    "@biomejs/biome" => Some("biome"),
                    "tsc" | "eslint" | "prettier" | "vitest" | "jest" | "mocha" | "playwright" | "tsx" | "ts-node" | "vite" | "next" | "esbuild" | "rollup" | "tsup" | "biome" | "turbo" | "nx" | "wrangler" | "drizzle-kit" | "prisma" | "tailwindcss" | "postcss" | "sass" | "babel" | "webpack" | "nuxt" | "astro" | "storybook" | "cypress" | "ava" | "karma" | "lint-staged" | "stylelint" | "markdownlint" | "markdownlint-cli2" | "nodemon" | "tsc-alias" | "vue-tsc" | "svelte-check" | "knip" | "depcheck" | "madge" | "size-limit" | "ts-node-dev" | "concurrently" | "cross-env" | "rimraf" | "serve" | "http-server" | "oxlint" | "zx" => Some(bare),
                    _ => None,
                };
                if let Some(cmd) = cmd {
                    let rest = args[skip + 1..].to_vec();
                    self.dispatch(cmd, &rest, io, st);
                    return;
                }
            }
        }
        if (name == "npx" && (o.long("no-install") || o.long("no"))) || (name == "pipx" && !o.ops.first().is_some_and(|v| matches!(v.exact(), Some("run") | Some("install") | Some("inject") | Some("upgrade") | Some("upgrade-all") | Some("reinstall-all") | Some("uninstall") | Some("uninstall-all") | Some("ensurepath") | Some("runpip")))) {
            return;
        }
        if name == "pipx" {
            let verb = o.ops.first().and_then(|v| v.exact()).unwrap_or("").to_string();
            if matches!(verb.as_str(), "list" | "environment" | "--version" | "") {
                return;
            }
        }
        self.ask(Kind::Network, format!("{name} runs a package fetched from the network"));
    }

    pub(crate) fn dev_pip(&mut self, args: &[Val], st: &State) {
        let o = getopt(args, "rcetiPCfdO", &["requirement", "constraint", "editable", "target", "index-url", "extra-index-url", "find-links", "dest", "prefix", "root", "src", "cache-dir", "log", "proxy", "retries", "timeout", "trusted-host", "platform", "python-version", "implementation", "abi", "config-settings", "global-option", "install-option", "build-option", "progress-bar", "report", "format", "python", "keyring-provider", "cert", "client-cert"]);
        let Some(sub) = o.ops.first().and_then(|v| v.exact()).map(str::to_string) else { return };
        match sub.as_str() {
            "install" | "uninstall" | "remove_" => {
                if let Some(t) = o.val("t").or_else(|| o.val("target")).or_else(|| o.val("prefix")).or_else(|| o.val("root")) {
                    let t = t.clone();
                    self.write_path(&t, st, "pip installs into");
                } else {
                    self.ask(Kind::Write, format!("pip {sub} changes the Python environment"));
                }
                if o.val("index-url").is_some() || o.val("i").is_some() || o.val("extra-index-url").is_some() {
                    self.ask(Kind::Code, "pip installs from an index the command names, which can run code at install");
                }
            }
            "download" => {
                if let Some(d) = o.val("d").or_else(|| o.val("dest")) {
                    let d = d.clone();
                    self.write_path(&d, st, "pip downloads into");
                }
            }
            "wheel" => {
                if let Some(d) = o.val("w").or_else(|| o.val("wheel-dir")) {
                    let d = d.clone();
                    self.write_path(&d, st, "pip writes");
                }
            }
            "list" | "show" | "freeze" | "check" | "index" | "inspect" | "hash" | "debug" | "help" | "search" | "cache" => {
                if sub == "cache" && o.ops.get(1).is_some_and(|v| matches!(v.exact(), Some("purge") | Some("remove"))) {
                    self.ask(Kind::Destructive, "pip cache purge deletes the shared download cache");
                }
            }
            "config" => {
                if o.ops.get(1).is_some_and(|v| matches!(v.exact(), Some("set") | Some("unset") | Some("edit"))) {
                    self.ask(Kind::Write, "pip config changes the person's configuration");
                }
            }
            other => self.ask(Kind::Unknown, format!("unknown pip subcommand: {other}")),
        }
    }

    fn uv(&mut self, args: &[Val], io: &Io, st: &mut State) {
        let o = getopt(args, "pCPfcmw", &["directory", "project", "python", "cache-dir", "config-file", "index-url", "extra-index-url", "default-index", "index", "with", "with-requirements", "with-editable", "env-file", "group", "extra", "only-group", "no-group", "package", "from", "script", "target", "prefix", "output-file", "constraint", "override", "exclude-newer", "index-strategy", "keyring-provider", "link-mode", "color", "python-platform", "python-version", "resolution", "refresh-package", "reinstall-package", "upgrade-package", "no-binary-package", "no-build-package"]);
        let Some(sub) = o.ops.first().and_then(|v| v.exact()).map(str::to_string) else { return };
        let verb = o.ops.get(1).and_then(|v| v.exact()).unwrap_or("").to_string();
        match sub.as_str() {
            "run" => {
                // `uv run [options] cmd args`
                let start = args.iter().position(|a| a.exact() == Some("run")).map(|k| k + 1).unwrap_or(0);
                let tail = &args[start..];
                let skip = super::wrap::skip_opts(tail, "pCPfcmw", &["directory", "project", "python", "cache-dir", "config-file", "index-url", "extra-index-url", "default-index", "index", "with", "with-requirements", "with-editable", "env-file", "group", "extra", "only-group", "no-group", "package", "script", "python-platform", "python-version", "resolution", "refresh-package", "reinstall-package", "upgrade-package", "exclude-newer", "link-mode", "color", "index-strategy", "keyring-provider", "no-binary-package", "no-build-package"]);
                let inner = tail.get(skip..).unwrap_or(&[]).to_vec();
                if !inner.is_empty() {
                    let mut s = st.clone();
                    self.run(inner, &[], io, &mut s);
                }
            }
            "sync" | "lock" | "add" | "remove" | "venv" | "init" | "tree" | "build" | "version" | "export" | "format" | "help" | "run_" | "audit" | "self_" => {
                if sub == "venv" || sub == "init" || sub == "build" {
                    if let Some(d) = o.ops.get(1) {
                        let d = d.clone();
                        self.write_path(&d, st, "uv creates");
                    }
                }
            }
            "pip" => {
                if matches!(verb.as_str(), "install" | "uninstall" | "sync") && (o.long("system") || o.long("break-system-packages") || o.long("user")) {
                    self.ask(Kind::Write, "uv pip changes the system Python environment");
                } else if matches!(verb.as_str(), "compile") {
                    if let Some(f) = o.val("o").or_else(|| o.val("output-file")) {
                        let f = f.clone();
                        self.write_path(&f, st, "uv writes");
                    }
                }
            }
            "tool" => {
                if matches!(verb.as_str(), "list" | "dir" | "") {
                    return;
                }
                self.ask(Kind::Network, format!("uv tool {verb} installs or runs a package fetched from the network"));
            }
            "python" => {
                if matches!(verb.as_str(), "list" | "find" | "dir" | "pin") {
                    return;
                }
                self.ask(Kind::Write, format!("uv python {verb} changes the installed interpreters"));
            }
            "publish" => self.ask(Kind::Publishing, "uv publish releases a package"),
            "cache" => {
                if matches!(verb.as_str(), "clean" | "prune") {
                    self.ask(Kind::Destructive, format!("uv cache {verb} deletes the shared cache"));
                }
            }
            "self" => self.ask(Kind::Write, "uv self changes the installed uv"),
            other => self.ask(Kind::Unknown, format!("unknown uv subcommand: {other}")),
        }
    }

    /// Version managers, environment runners and package managers of other languages.
    fn env_manager(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        let sub = args.iter().find(|a| !a.starts("-")).and_then(|a| a.exact()).unwrap_or("").to_string();
        let pos = args.iter().position(|a| a.exact() == Some(sub.as_str())).map(|p| p + 1).unwrap_or(args.len());
        let tail = &args[pos.min(args.len())..];
        // `run` forms: the rest is a command to run in the environment.
        let wraps = matches!((name, sub.as_str()), ("poetry", "run") | ("pdm", "run") | ("pipenv", "run") | ("hatch", "run") | ("rye", "run") | ("conda", "run") | ("mamba", "run") | ("micromamba", "run") | ("mise", "exec") | ("mise", "x") | ("rtx", "exec") | ("asdf", "exec") | ("direnv", "exec") | ("devbox", "run") | ("volta", "run") | ("bundle", "exec") | ("nix", "develop") | ("nix", "shell") | ("nix-shell", _));
        if wraps {
            if name == "nix-shell" || name == "nix" {
                let o = getopt(args, "c", &["run", "command"]);
                if let Some(c) = o.val("run").or_else(|| o.val("command")).or_else(|| o.val("c")) {
                    let c = c.clone();
                    self.nested_string(&c, st, name);
                }
                return;
            }
            let skip = match name {
                "conda" | "mamba" | "micromamba" => super::wrap::skip_opts(tail, "nepc", &["name", "prefix", "cwd"]),
                "direnv" => 1,
                _ => super::wrap::skip_opts(tail, "", &[]),
            };
            let inner = tail.get(skip..).unwrap_or(&[]).to_vec();
            if !inner.is_empty() {
                let mut s = st.clone();
                self.run(inner, &[], io, &mut s);
            }
            return;
        }
        match (name, sub.as_str()) {
            ("poetry", "publish") | ("pdm", "publish") | ("hatch", "publish") | ("gem", "push") | ("composer", "publish_") | ("dotnet", "nuget") => {
                if name == "dotnet" && !tail.iter().any(|a| a.is("push")) {
                    return;
                }
                self.ask(Kind::Publishing, format!("{name} {sub} releases a package"));
            }
            ("poetry", "config") | ("pdm", "config") | ("conda", "config") | ("rustup", "set") | ("rustup", "self") | ("rustup", "toolchain") | ("rustup", "component") | ("rustup", "target") | ("rustup", "update") | ("rustup", "install") | ("rustup", "default") | ("rustup", "override") | ("rustup", "uninstall") | ("rustup", "run_") => {
                let reading = matches!(tail.first().and_then(|a| a.exact()), Some("list") | Some("show") | Some("get") | Some("--list"));
                if !reading && !(name == "poetry" && sub == "config" && tail.is_empty()) {
                    self.ask(Kind::Write, format!("{name} {sub} changes the installed tools or the person's configuration"));
                }
            }
            ("rustup", "run") => {
                let inner = tail.get(1..).unwrap_or(&[]).to_vec();
                if !inner.is_empty() {
                    let mut s = st.clone();
                    self.run(inner, &[], io, &mut s);
                }
            }
            ("rustup", _) | ("brew", "install") | ("brew", "uninstall") | ("brew", "upgrade") | ("brew", "reinstall") | ("brew", "tap") | ("brew", "untap") | ("brew", "update") | ("brew", "link") | ("brew", "unlink") | ("brew", "services") | ("brew", "cleanup") | ("brew", "autoremove") | ("brew", "pin") | ("brew", "unpin") | ("brew", "bundle") | ("brew", "remove") | ("brew", "rm") | ("gem", "install") | ("gem", "uninstall") | ("gem", "update") | ("composer", "global") | ("composer", "require") | ("nuget", "install_") => {
                if name == "rustup" && matches!(sub.as_str(), "show" | "which" | "doc" | "man" | "completions") {
                    return;
                }
                self.ask(Kind::Write, format!("{name} {sub} installs or removes software outside the workspace"));
            }
            ("brew", _) | ("gem", _) | ("bundle", _) | ("composer", _) | ("dotnet", _) | ("nuget", _) => {
                if name == "dotnet" && matches!(sub.as_str(), "tool" | "workload" | "new_") {
                    self.ask(Kind::Write, format!("dotnet {sub} installs software outside the workspace"));
                }
                if name == "bundle" && matches!(sub.as_str(), "install" | "update") {
                    // Gems into vendor/bundle or the system: ask when there is no --path.
                    if !args.iter().any(|a| a.starts("--path")) && !args.iter().any(|a| a.is("--deployment")) {
                        self.ask(Kind::Write, "bundle install puts gems where the configuration says");
                    }
                }
            }
            ("nvm", _) | ("fnm", _) | ("volta", _) | ("pyenv", _) | ("rbenv", _) | ("asdf", _) | ("mise", _) | ("rtx", _) | ("devbox", _) | ("nix", _) | ("direnv", _) | ("conda", _) | ("mamba", _) | ("micromamba", _) | ("poetry", _) | ("pdm", _) | ("pipenv", _) | ("hatch", _) | ("rye", _) | ("nix-shell", _) => {
                let installs = matches!(sub.as_str(), "install" | "uninstall" | "remove" | "rm" | "update" | "upgrade" | "use_" | "global" | "local" | "shell_" | "add_" | "plugin" | "create" | "activate_" | "init_" | "reshim" | "allow" | "deny" | "edit" | "env_" | "pin" | "i" | "un" | "self");
                let project_local = matches!((name, sub.as_str()), ("poetry", "install") | ("poetry", "add") | ("poetry", "remove") | ("poetry", "update") | ("poetry", "lock") | ("pdm", "install") | ("pdm", "add") | ("pdm", "remove") | ("pdm", "update") | ("pdm", "lock") | ("pdm", "sync") | ("pipenv", "install") | ("pipenv", "uninstall") | ("pipenv", "lock") | ("hatch", "env") | ("rye", "sync") | ("rye", "add") | ("rye", "remove") | ("rye", "lock") | ("direnv", "allow") | ("direnv", "reload"));
                if installs && !project_local {
                    self.ask(Kind::Write, format!("{name} {sub} installs or removes software outside the workspace"));
                }
            }
            _ => {}
        }
        let _: Place = Place::Work;
    }
}
