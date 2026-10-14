//! Commands that operate machines, clusters, clouds and databases: the verbs that read, the
//! verbs that change, and the verbs that destroy.

// Rule tables name a verb under its group and again under any group; the first arm that matches decides.
#![allow(unreachable_patterns)]

use super::getopt;
use crate::sql::{self, Sql};
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{Io, Out, State, Stdin, Walker};

/// Words in a cloud command that say it only reads.
fn reading_verb(w: &str) -> bool {
    let w = w.to_ascii_lowercase();
    matches!(w.as_str(), "ls" | "list" | "show" | "view" | "status" | "info" | "logs" | "tail" | "whoami" | "version" | "help" | "search" | "query" | "inspect" | "check" | "validate" | "lookup" | "find" | "diff" | "plan" | "preview" | "history" | "top" | "events" | "doctor" | "ping" | "describe" | "get" | "wait" | "watch" | "explain" | "export_" | "tree" | "graph" | "output" | "outputs" | "dump_")
        || w.starts_with("list-") || w.starts_with("describe-") || w.starts_with("get-") && !secret_verb(&w) || w.starts_with("show-") || w.starts_with("batch-get-") || w.starts_with("lookup-") || w.starts_with("search-") || w.starts_with("query-") || w.starts_with("head-") || w.starts_with("check-") || w.starts_with("validate-") || w.starts_with("estimate-") || w.starts_with("simulate-")
}

fn destroying_verb(w: &str) -> bool {
    let w = w.to_ascii_lowercase();
    matches!(w.as_str(), "delete" | "remove" | "rm" | "rb" | "terminate" | "destroy" | "purge" | "drop" | "wipe" | "deregister" | "detach" | "disassociate" | "revoke" | "shutdown" | "kill" | "uninstall" | "undeploy" | "unpublish" | "erase" | "prune" | "teardown" | "decommission" | "reset" | "truncate")
        || w.starts_with("delete-") || w.starts_with("remove-") || w.starts_with("terminate-") || w.starts_with("destroy-") || w.starts_with("deregister-") || w.starts_with("purge-") || w.starts_with("detach-") || w.starts_with("revoke-") || w.starts_with("disassociate-") || w.starts_with("deactivate-") || w.starts_with("disable-") && false
}

/// Verbs that hand back a credential.
fn secret_verb(w: &str) -> bool {
    let w = w.to_ascii_lowercase();
    w.contains("get-secret-value") || w.contains("get-login-password") || w.contains("get-authorization-token") || w.contains("get-session-token") || w.starts_with("assume-role") || w.contains("export-credentials") || w.contains("get-role-credentials") || w.contains("create-access-key") || w.contains("get-credential-report") || w.contains("generate-credential-report") || w.contains("get-credentials-for-identity") || w.contains("get-id-token") || w.contains("get-federation-token") || w == "decrypt" || w.contains("generate-data-key") || w.contains("get-parameters-by-path") && false || w.contains("get-access-token") || w.contains("print-access-token") || w.contains("print-identity-token") || w.contains("get-pipeline-state_")
}

impl Walker<'_> {
    pub(crate) fn ops_command(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) -> Option<Out> {
        match name {
            "docker" | "podman" | "nerdctl" | "docker-compose" | "podman-compose" | "buildah" | "skopeo" | "ctr" | "crictl" | "lima" | "limactl" | "colima" | "orb" | "orbctl" => self.docker(name, args, st),
            "kubectl" | "oc" | "microk8s" | "k3s" | "kubectl-argo-rollouts" | "kubeadm" | "kubelet" | "etcdctl" => self.kubectl(name, args, st),
            "helm" | "helmfile" | "kustomize" | "skaffold" | "tilt" | "argocd" | "flux" | "istioctl" | "linkerd" | "velero" | "kubeseal" | "k9s" | "kubectx" | "kubens" | "kind" | "minikube" | "k3d" | "stern" | "kubetail" | "eksctl" | "kops" | "rancher" | "nomad" | "consul" | "vault_" => self.k8s_tool(name, args, st),
            "terraform" | "tofu" | "terragrunt" | "pulumi" | "cdk" | "cdktf" | "packer" | "vagrant" | "ansible" | "ansible-playbook" | "ansible-galaxy" | "salt" | "salt-call" | "chef" | "puppet" | "crossplane" | "tfsec" | "tflint" | "terraform-docs" | "checkov" | "infracost" | "atlantis" | "spacectl" | "cloudformation_" | "sam" | "serverless" | "sls" | "copilot" | "cdk8s" => self.iac(name, args, st),
            "aws" | "gcloud" | "gsutil" | "az" | "doctl" | "flyctl" | "fly" | "vercel" | "netlify" | "wrangler" | "supabase" | "firebase" | "heroku" | "railway" | "render" | "ibmcloud" | "oci" | "linode-cli" | "scw" | "hcloud" | "civo" | "upctl" | "exoscale" | "aliyun" | "tccli" | "cf" | "oc-cloud_" | "mc" | "s3cmd" | "rclone" | "azcopy" | "bq" | "gcloud-storage_" | "stripe" | "twilio" | "sendgrid" | "cloudflared" | "ngrok" | "crane" | "gcrane" | "oras" | "regctl" | "cosign" => self.cloud(name, args, st),
            "gh" | "glab" | "hub" | "tea" | "bitbucket" | "jira" | "linear" => self.gh(name, args, st),
            "systemctl" | "service" | "rc-service" | "sv" | "supervisorctl" | "initctl" | "chkconfig" | "update-rc.d" => self.service(name, args),
            "shutdown" | "reboot" | "poweroff" | "halt" | "telinit" | "init" | "killall5" | "kexec" => {
                if name == "init" && !args.iter().any(|a| matches!(a.exact(), Some("0") | Some("6") | Some("1") | Some("s") | Some("S"))) {
                    return Some(Out::default());
                }
                self.deny(Kind::Destructive, format!("{name} powers the machine off, restarts it or kills every process"));
            }
            "pkill" | "killall" | "skill" | "fuser" | "pidwait_" | "xkill" => {
                let o = getopt(args, "stuUgGPvnoeaPTc", &[]);
                if name == "fuser" && !o.has('k') {
                    return Some(Out::default());
                }
                if o.has('1') || o.ops.iter().any(|v| v.is("-1")) && o.has('9') {
                    self.deny(Kind::Destructive, format!("{name} signals every process"));
                } else {
                    let what = o.ops.first().map(|v| v.show()).unwrap_or_default();
                    self.ask(Kind::Destructive, format!("{name} signals every process matching {what}"));
                }
            }
            "apt" | "apt-get" | "aptitude" | "dpkg" | "dnf" | "yum" | "zypper" | "pacman" | "apk" | "snap" | "flatpak" | "rpm" | "nix-env" | "pkg" | "port" | "choco" | "scoop" | "winget" | "emerge" | "xbps-install" | "opkg" | "yay" | "paru" | "pkcon" | "dpkg-reconfigure" | "update-alternatives" | "add-apt-repository" | "apt-key" | "ldconfig" | "depmod" | "update-grub" | "grub-install" | "dracut" | "mkinitcpio" | "update-initramfs" | "localectl_" => self.packages(name, args),
            "useradd" | "userdel" | "usermod" | "groupadd" | "groupdel" | "groupmod" | "adduser" | "deluser" | "addgroup" | "delgroup" | "visudo" | "vipw" | "vigr" | "modprobe" | "insmod" | "rmmod" | "kmod" | "dkms" | "auditctl" | "setenforce" | "aa-enforce" | "aa-complain" | "semanage" | "setsebool" | "sestatus_" | "chsh" | "chfn" | "gpasswd" | "pwconv" | "grpconv" | "hwclock" | "ntpdate" | "chronyc" | "timedatectl_" | "wipe" | "srm" | "blkid_" | "partprobe" | "mdadm" | "lvcreate" | "lvextend" | "vgcreate" | "vgextend" | "pvcreate" | "zfs" | "zpool" | "btrfs" | "xfs_repair" | "xfs_growfs" | "mkdosfs" | "format" | "diskpart" | "bcdedit" | "reg" | "regedit" | "net" | "netsh" | "sc" | "schtasks" | "wmic" | "icacls" | "takeown" => {
                if matches!(name, "zfs" | "zpool" | "btrfs" | "mdadm") && args.iter().any(|a| matches!(a.exact(), Some("list") | Some("status") | Some("get") | Some("show") | Some("--detail") | Some("-D") | Some("version"))) {
                    return Some(Out::default());
                }
                self.deny(Kind::Privilege, format!("{name} changes accounts, kernel modules, disks or system settings"));
            }
            "psql" | "pgcli" | "usql" | "mysql" | "mariadb" | "mycli" | "litecli" | "sqlite3" | "sqlite" | "duckdb" | "clickhouse-client" | "clickhouse" | "clickhouse-local" | "cockroach" | "mongosh" | "mongo" | "redis-cli" | "valkey-cli" | "rediscli" | "cqlsh" | "influx" | "sqlcmd" | "bq_" | "snowsql" | "trino" | "presto" | "beeline" | "spark-sql" | "dbt" | "atlas" | "migrate" | "goose" | "sqitch" | "flyway" | "liquibase" | "prisma" | "drizzle-kit" | "sequelize" | "typeorm" | "knex" | "alembic" | "pg_dump" | "pg_restore" | "pg_dumpall" | "mysqldump" | "mongodump" | "mongorestore" | "createdb" | "dropdb" | "createuser" | "dropuser" | "pg_ctl" | "initdb" | "vacuumdb" | "reindexdb" | "pg_upgrade" | "pg_basebackup" => self.database(name, args, io, st),
            "hanzo" | "lux" | "luxd" | "hanzod" => self.hanzo(name, args, st),
            _ => return None,
        }
        Some(Out::default())
    }

    // ----- docker -----

    fn docker(&mut self, name: &str, args: &[Val], st: &mut State) {
        let o = getopt(args, "HcCDl", &["host", "context", "config", "log-level", "tlscacert", "tlscert", "tlskey", "H"]);
        if let Some(h) = o.val("H").or_else(|| o.val("host")) {
            if !h.starts("unix://") {
                self.ask(Kind::Network, format!("{name} talks to a remote daemon: {}", h.show()));
            }
        }
        let skip = super::wrap::skip_opts(args, "HcCDl", &["host", "context", "config", "log-level", "tlscacert", "tlscert", "tlskey"]);
        let rest = args.get(skip..).unwrap_or(&[]);
        let Some(first) = rest.first().and_then(|v| v.exact()).map(str::to_string) else { return };
        // `docker container rm`, `docker image ls`, `docker compose up`, `docker buildx build`.
        let (group, verb, tail): (String, String, &[Val]) = match first.as_str() {
            "container" | "image" | "volume" | "network" | "system" | "compose" | "buildx" | "builder" | "context" | "manifest" | "trust" | "plugin" | "node" | "service" | "stack" | "swarm" | "secret" | "config" | "checkpoint" | "scout" | "model" | "mcp" | "sbom" | "init" | "debug" | "extension" | "desktop" | "offload" => {
                let v = rest.iter().skip(1).find(|a| !a.starts("-")).and_then(|a| a.exact()).unwrap_or("").to_string();
                (first.clone(), v, &rest[1..])
            }
            other => ("".into(), other.to_string(), &rest[1..]),
        };
        let verb = if name.ends_with("compose") && group.is_empty() { first.clone() } else { verb };
        let group = if name.ends_with("compose") { "compose".to_string() } else { group };
        let tail = if name.ends_with("compose") && !rest.is_empty() { &rest[1..] } else { tail };
        let reads = ["ps", "images", "logs", "inspect", "version", "info", "stats", "top", "port", "diff", "history", "search", "events", "ls", "list", "config", "ps-a", "df", "show", "du", "ps", "stat", "tree", "-v", "--version", "help", "completion", "check", "export_", "pull", "images", "convert", "viz", "wait_"];
        match (group.as_str(), verb.as_str()) {
            (_, "build") | (_, "bake") | ("buildx", "build") | ("builder", "build") | ("image", "build") => {
                let b = getopt(tail, "fotTCfFmcaglsnpL", &["file", "output", "tag", "platform", "build-arg", "secret", "ssh", "cache-from", "cache-to", "target", "label", "network", "builder", "iidfile", "metadata-file", "progress", "provenance", "sbom", "add-host", "ulimit", "memory", "cpuset-cpus", "shm-size", "attest", "allow", "build-context", "call", "check_"]);
                if b.long("push") {
                    self.ask(Kind::Publishing, format!("{name} build --push publishes the image"));
                }
                if let Some(f) = b.val("f").or_else(|| b.val("file")) {
                    let f = f.clone();
                    self.read_path(&f, st, "reads");
                }
                for k in ["o", "output", "iidfile", "metadata-file"] {
                    if let Some(f) = b.val(k) {
                        let dest = f.s.split(',').find_map(|p| p.strip_prefix("dest=")).map(str::to_string).unwrap_or_else(|| if f.s.contains("type=") { String::new() } else { f.s.clone() });
                        if !dest.is_empty() {
                            self.write_path(&Val::lit(dest), st, "writes");
                        }
                    }
                }
                if let Some(s) = b.val("secret") {
                    if let Some(src) = s.s.split(',').find_map(|p| p.strip_prefix("src=")) {
                        self.use_path(&Val::lit(src.to_string()), st, "passes");
                    }
                }
                if let Some(ctx) = b.ops.last() {
                    let ctx = ctx.clone();
                    if !ctx.starts("http") && !ctx.starts("git@") && !ctx.is("-") {
                        let s = self.sense(&ctx, st);
                        if matches!(s.place, crate::path::Place::System | crate::path::Place::Root | crate::path::Place::Broad | crate::path::Place::Home) {
                            self.ask(Kind::Credential, format!("{name} build sends {} to the daemon as context", ctx.show()));
                        }
                    }
                }
            }
            ("compose", v) if reads.contains(&v) || v.is_empty() => {}
            ("compose", "build") | ("compose", "pull") | ("compose", "create") => {}
            (_, "run") | ("container", "run") | (_, "create") | ("container", "create") => self.docker_run(name, &verb, tail, st),
            (_, "exec") | ("container", "exec") | ("compose", "exec") | ("compose", "run") | ("compose", "up") | ("compose", "restart") | ("compose", "start") | ("compose", "stop") | ("compose", "scale") => {
                self.ask(Kind::Write, format!("{name} {verb} starts or enters a container"));
            }
            (_, "push") | ("image", "push") | ("compose", "push") | ("manifest", "push") => self.ask(Kind::Publishing, format!("{name} push publishes an image")),
            (_, "login") | (_, "logout") => self.ask(Kind::Credential, format!("{name} {verb} changes the registry login")),
            (_, "pull") | ("image", "pull") => {}
            (_, v) if reads.contains(&v) => {}
            (_, "rm") | (_, "rmi") | (_, "kill") | (_, "prune") | ("compose", "down") | ("volume", "rm") | ("network", "rm") | ("image", "rm") | ("container", "rm") | (_, "stop") | (_, "start") | (_, "restart") | (_, "pause") | (_, "unpause") | (_, "cp") | (_, "commit") | (_, "tag") | (_, "save") | (_, "load") | (_, "export") | (_, "import") | (_, "rename") | (_, "update") | (_, "attach") | (_, "wait") | (_, "create") | ("swarm", _) | ("service", _) | ("stack", _) | ("secret", _) | ("config", _) | ("plugin", _) | ("node", _) | ("context", _) | ("system", _) | ("network", _) | ("volume", _) | ("builder", _) | ("buildx", _) => {
                let kind = if matches!(verb.as_str(), "rm" | "rmi" | "kill" | "prune") || group == "compose" && verb == "down" { Kind::Destructive } else { Kind::Write };
                self.ask(kind, format!("{name} {verb} changes containers, images or volumes"));
            }
            _ => self.ask(Kind::Unknown, format!("unknown {name} subcommand: {first}")),
        }
    }

    fn docker_run(&mut self, name: &str, verb: &str, tail: &[Val], st: &State) {
        let o = getopt(tail, "vupwhelnmaecrCdtiPUWHDSX", &["volume", "mount", "user", "publish", "workdir", "hostname", "env", "env-file", "label", "name", "network", "net", "memory", "cpus", "entrypoint", "cap-add", "cap-drop", "device", "security-opt", "pid", "ipc", "userns", "uts", "cgroupns", "add-host", "dns", "restart", "platform", "pull", "runtime", "gpus", "shm-size", "tmpfs", "ulimit", "log-driver", "log-opt", "health-cmd", "stop-signal", "stop-timeout", "sysctl", "group-add", "cidfile", "init_", "detach-keys"]);
        let mut bad: Option<String> = None;
        if o.long("privileged") {
            bad = Some("--privileged".into());
        }
        for (n, v) in &o.vals {
            let t = v.s.as_str();
            match n.as_str() {
                "pid" | "ipc" | "userns" | "uts" | "cgroupns" if t == "host" => bad = Some(format!("--{n}=host")),
                "cap-add" if matches!(t.to_ascii_uppercase().as_str(), "ALL" | "SYS_ADMIN" | "SYS_PTRACE" | "SYS_MODULE" | "SYS_RAWIO" | "DAC_READ_SEARCH" | "NET_ADMIN_") => bad = Some(format!("--cap-add {t}")),
                "security-opt" if t.contains("unconfined") || t.contains("seccomp=") && t.contains("unconfined") => bad = Some("--security-opt unconfined".into()),
                "device" if t.starts_with("/dev/mem") || t.starts_with("/dev/sd") || t.starts_with("/dev/nvme") => bad = Some(format!("--device {t}")),
                "v" | "volume" | "mount" => {
                    let host = if n == "mount" { t.split(',').find_map(|p| p.strip_prefix("source=").or_else(|| p.strip_prefix("src="))).unwrap_or("") } else { t.split(':').next().unwrap_or("") };
                    if host.starts_with('/') || host.starts_with('~') || host.starts_with('.') {
                        let hv = Val::lit(host.to_string());
                        let s = self.sense(&hv, st);
                        use crate::path::Place;
                        if host.contains("docker.sock") || matches!(s.place, Place::Root | Place::System | Place::Broad | Place::Home | Place::Disk) {
                            bad = Some(format!("a mount of {host}"));
                        } else if let Some(secret) = s.secret {
                            self.ask(Kind::Credential, format!("{name} mounts {secret}: {host}"));
                        } else if !matches!(s.place, Place::Work | Place::Anchor | Place::Temp | Place::TempRoot) {
                            self.ask(Kind::Write, format!("{name} mounts a path outside the workspace: {host}"));
                        }
                    }
                }
                "env-file" => {
                    let v = v.clone();
                    self.use_path(&v, st, "passes");
                }
                _ => {}
            }
        }
        if let Some(b) = bad {
            self.deny(Kind::Privilege, format!("{name} {verb} gives the container the host ({b})"));
        } else {
            self.ask(Kind::Write, format!("{name} {verb} starts a container"));
        }
    }

    // ----- kubernetes -----

    fn kubectl(&mut self, name: &str, args: &[Val], st: &State) {
        let long_val = ["kubeconfig", "context", "namespace", "server", "user", "cluster", "token", "as", "as-group", "request-timeout", "cache-dir", "tls-server-name", "certificate-authority", "client-certificate", "client-key", "username", "password", "profile", "profile-output", "log-flush-frequency", "v", "vmodule"];
        let skip = super::wrap::skip_opts(args, "nsvA", &long_val);
        let o = getopt(args, "nsvAoLlf", &["output", "selector", "field-selector", "filename", "label-columns", "sort-by", "template", "container", "tail", "since", "since-time", "limit", "chunk-size", "type", "patch", "patch-file", "replicas", "image", "from-file", "from-literal", "from-env-file", "kubeconfig", "context", "namespace", "server", "user", "cluster", "token", "as", "as-group", "request-timeout", "cache-dir", "tls-server-name", "certificate-authority", "client-certificate", "client-key", "username", "password"]);
        for k in ["kubeconfig", "certificate-authority", "client-certificate", "client-key"] {
            let _ = k;
        }
        if o.val("token").is_some() {
            // A token on the command line is shown in process lists; asked about by the generic rule.
        }
        let Some(verb) = args.get(skip).and_then(|v| v.exact()).map(str::to_string) else { return };
        let rest = &args[skip + 1..];
        let words: Vec<&str> = rest.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
        let secret_resource = words.iter().any(|w| {
            let l = w.to_ascii_lowercase();
            l == "secret" || l == "secrets" || l.starts_with("secret/") || l.starts_with("secrets/") || l.starts_with("secret,") || l.contains(",secret") || l.starts_with("secrets.") || l.starts_with("secret.")
        });
        let outputs_data = o.val("o").or_else(|| o.val("output")).is_some_and(|v| !matches!(v.s.as_str(), "name" | "wide" | ""));
        match verb.as_str() {
            "get" | "describe" | "logs" | "top" | "explain" | "api-resources" | "api-versions" | "cluster-info" | "version" | "events" | "diff" | "auth" | "wait" | "completion" | "plugin" | "kustomize" | "options" | "help" | "status" | "list" | "member" | "endpoint" | "alarm" | "check" | "snapshot_" | "node" | "pod" | "ps" => {
                if verb == "get" && secret_resource && (outputs_data || rest.iter().any(|v| v.starts("-o") || v.starts("--output"))) {
                    // A certificate is in a secret and is public; the key beside it is not.
                    let expr: String = rest.iter().map(|v| v.s.clone()).collect::<Vec<_>>().join(" ");
                    let mut stripped = expr.clone();
                    for key in [".data.tls\\.crt", ".data.tls.crt", ".data.ca\\.crt", ".data.ca.crt", ".data.ca-bundle.crt", ".data[\"tls.crt\"]", ".data[\"ca.crt\"]"] {
                        stripped = stripped.replace(key, "");
                    }
                    let only_public = (expr.contains("jsonpath") || expr.contains("custom-columns")) && !stripped.contains(".data") && !stripped.contains("stringData") && !stripped.contains("{.}") && !stripped.contains("{@}") && !stripped.contains("go-template") && !stripped.contains("range");
                    if !only_public {
                        self.deny(Kind::Credential, format!("{name} get secret prints the secret data"));
                    }
                }
                if verb == "get" && secret_resource && o.long("show-managed-fields_") {
                    self.deny(Kind::Credential, "prints secrets");
                }
            }
            "config" => {
                let sub = words.first().copied().unwrap_or("");
                match sub {
                    "view" => {
                        if o.long("raw") {
                            self.deny(Kind::Credential, format!("{name} config view --raw prints the kubeconfig's credentials"));
                        }
                    }
                    "get-contexts" | "current-context" | "get-clusters" | "get-users" | "" | "get-contexts_" => {}
                    _ => self.ask(Kind::Write, format!("{name} config {sub} changes the kubeconfig")),
                }
            }
            "delete" => self.deny(Kind::Destructive, format!("{name} delete removes cluster resources")),
            "drain" | "cordon" | "uncordon" | "taint" => self.ask(Kind::Destructive, format!("{name} {verb} disrupts a node")),
            "rollout" => {
                if !words.first().is_some_and(|w| matches!(*w, "status" | "history")) {
                    self.ask(Kind::Write, format!("{name} rollout changes a workload"));
                }
            }
            "exec" | "cp" | "port-forward" | "proxy" | "attach" | "debug" | "run" | "create" | "apply" | "patch" | "edit" | "replace" | "scale" | "set" | "label" | "annotate" | "expose" | "autoscale" | "certificate" | "annotate_" | "apply-set_" | "kubeadm_" | "token" | "init" | "join" | "reset" | "upgrade" | "put" | "del" | "defrag" | "restore" | "start" | "stop" | "restart" | "install" => {
                if matches!(verb.as_str(), "reset" | "del") {
                    self.deny(Kind::Destructive, format!("{name} {verb} destroys cluster state"));
                } else {
                    self.ask(Kind::Write, format!("{name} {verb} changes or enters the cluster"));
                }
            }
            other => self.ask(Kind::Unknown, format!("unknown {name} subcommand: {other}")),
        }
        let _ = st;
    }

    fn k8s_tool(&mut self, name: &str, args: &[Val], st: &State) {
        let words: Vec<&str> = args.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
        let verb = words.first().copied().unwrap_or("");
        match name {
            "helm" | "helmfile" => match verb {
                "list" | "ls" | "status" | "show" | "search" | "env" | "version" | "history" | "template" | "lint" | "verify" | "completion" | "help" | "diff" | "" => {}
                "get" => {
                    if words.get(1).is_some_and(|w| matches!(*w, "values" | "all" | "manifest" | "hooks")) {
                        self.ask(Kind::Credential, "helm get prints values and manifests, which may hold secrets");
                    }
                }
                "uninstall" | "delete" | "del" | "un" | "destroy" => self.deny(Kind::Destructive, format!("{name} {verb} removes a release")),
                "package" | "pull" | "dependency" | "dep" | "create" => {}
                "push" => self.ask(Kind::Publishing, "helm push publishes a chart"),
                "registry" | "repo" | "plugin" if words.get(1).is_some_and(|w| matches!(*w, "list" | "ls" | "search")) => {}
                _ => self.ask(Kind::Write, format!("{name} {verb} installs or changes cluster state")),
            },
            "kustomize" => {
                if !matches!(verb, "build" | "version" | "cfg" | "completion" | "help" | "") {
                    self.ask(Kind::Write, format!("kustomize {verb} edits the kustomization"));
                }
            }
            "kind" | "minikube" | "k3d" | "eksctl" | "kops" => {
                if matches!(verb, "delete" | "destroy") || words.get(1).is_some_and(|w| *w == "delete") {
                    self.deny(Kind::Destructive, format!("{name} {verb} deletes a cluster"));
                } else if !matches!(verb, "get" | "version" | "status" | "ip" | "profile" | "service" | "logs" | "kubectl" | "get_" | "help" | "" | "list" | "ls" | "config") {
                    self.ask(Kind::Write, format!("{name} {verb} creates or changes a cluster"));
                }
            }
            "stern" | "kubetail" | "istioctl" | "linkerd" | "velero" | "argocd" | "flux" | "kubeseal" | "skaffold" | "tilt" | "nomad" | "consul" | "rancher" => {
                let read = matches!(verb, "get" | "list" | "ls" | "status" | "version" | "logs" | "describe" | "diff" | "check" | "proxy-status" | "analyze" | "help" | "" | "top" | "stat" | "members" | "info" | "tail");
                if matches!(verb, "delete" | "rm" | "destroy" | "uninstall") {
                    self.deny(Kind::Destructive, format!("{name} {verb} removes cluster resources"));
                } else if !read && name != "stern" && name != "kubetail" {
                    self.ask(Kind::Write, format!("{name} {verb} changes the cluster"));
                }
            }
            "k9s" | "kubectx" | "kubens" => {
                if !args.is_empty() || name == "k9s" {
                    self.ask(Kind::Write, format!("{name} switches or edits cluster context"));
                }
            }
            _ => {}
        }
        let _ = st;
    }

    // ----- infrastructure as code -----

    fn iac(&mut self, name: &str, args: &[Val], st: &State) {
        let words: Vec<&str> = args.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
        let verb = words.first().copied().unwrap_or("");
        let has = |w: &str| args.iter().any(|a| a.is(w));
        match name {
            "terraform" | "tofu" | "terragrunt" => match verb {
                "apply" | "destroy" | "run-all" | "run_all" => {
                    if verb == "run-all" && !words.get(1).is_some_and(|w| matches!(*w, "apply" | "destroy")) {
                        return;
                    }
                    self.deny(Kind::Destructive, format!("{name} {verb} changes or destroys infrastructure"));
                }
                "plan" | "validate" | "fmt" | "show" | "output" | "version" | "providers" | "graph" | "init" | "get" | "test" | "console" | "help" | "" | "hclfmt" | "hcl" | "terragrunt-info" | "render-json" | "find" => {
                    let o = getopt(args, "", &["out", "var-file", "backend-config", "state", "state-out", "chdir"]);
                    if let Some(f) = o.val("out") {
                        let f = f.clone();
                        self.write_path(&f, st, "writes the plan to");
                    }
                    if verb == "plan" && has("-destroy") {
                        // A plan of a destruction is still only a plan.
                    }
                    if let Some(f) = o.val("state") {
                        let f = f.clone();
                        self.read_path(&f, st, "reads");
                    }
                }
                "state" => {
                    let sub = words.get(1).copied().unwrap_or("");
                    if matches!(sub, "list" | "show" | "pull") {
                        if sub == "pull" || sub == "show" {
                            self.ask(Kind::Credential, format!("{name} state {sub} prints state, which holds secrets"));
                        }
                    } else {
                        self.ask(Kind::Destructive, format!("{name} state {sub} changes the state"));
                    }
                }
                "workspace" => {
                    if !matches!(words.get(1).copied(), Some("list") | Some("show") | Some("select")) {
                        self.ask(Kind::Write, format!("{name} workspace {} changes workspaces", words.get(1).copied().unwrap_or("")));
                    }
                }
                "login" | "logout" => self.ask(Kind::Credential, format!("{name} {verb} changes the registry login")),
                _ => self.ask(Kind::Write, format!("{name} {verb} changes infrastructure state")),
            },
            "pulumi" => match verb {
                "preview" | "version" | "whoami" | "about" | "help" | "" | "logs" | "history" | "ai_" => {}
                "up" | "destroy" | "refresh" | "import" | "cancel" => self.deny(Kind::Destructive, format!("pulumi {verb} changes or destroys infrastructure")),
                "stack" | "config" | "state" | "org" | "policy" | "plugin" | "package" | "new" | "login" | "logout" | "watch" | "convert" | "console" | "env" => {
                    let sub = words.get(1).copied().unwrap_or("");
                    if matches!(sub, "ls" | "list" | "output" | "get" | "history" | "select" | "tag" | "graph" | "export" | "" | "init") || matches!(verb, "plugin" | "package") && matches!(sub, "ls") {
                        if sub == "export" || (verb == "config" && has("--show-secrets")) {
                            self.ask(Kind::Credential, "pulumi prints state or config with secrets");
                        }
                    } else if matches!(sub, "rm" | "delete" | "remove") {
                        self.deny(Kind::Destructive, format!("pulumi {verb} {sub} deletes state"));
                    } else {
                        self.ask(Kind::Write, format!("pulumi {verb} {sub} changes configuration or state"));
                    }
                }
                _ => self.ask(Kind::Write, format!("pulumi {verb} changes infrastructure")),
            },
            "cdk" | "cdktf" | "cdk8s" => match verb {
                "synth" | "synthesize" | "diff" | "ls" | "list" | "doctor" | "context" | "docs" | "version" | "metadata" | "notices" | "init" | "" | "get" | "convert" | "help" => {}
                "destroy" => self.deny(Kind::Destructive, format!("{name} destroy removes stacks")),
                _ => self.ask(Kind::Write, format!("{name} {verb} deploys infrastructure")),
            },
            "ansible-playbook" | "ansible" | "salt" | "salt-call" | "puppet" | "chef" => {
                let check = has("--check") || has("-C") || has("--syntax-check") || has("--list-hosts") || has("--list-tasks") || has("--list-tags") || has("--version");
                if !check {
                    self.ask(Kind::Write, format!("{name} changes the machines it is aimed at"));
                }
            }
            "ansible-galaxy" => {
                if matches!(verb, "install" | "remove" | "init" | "import" | "delete" | "setup" | "login") {
                    self.ask(Kind::Write, format!("ansible-galaxy {verb} changes installed roles or published ones"));
                }
            }
            "packer" | "vagrant" | "sam" | "serverless" | "sls" | "copilot" | "crossplane" | "spacectl" | "atlantis" => {
                let read = matches!(verb, "validate" | "fmt" | "inspect" | "version" | "status" | "global-status" | "ssh-config" | "box" | "help" | "" | "list" | "logs" | "info" | "plugins" | "init" | "build_" | "local" | "validate_" | "package" | "config");
                if matches!(verb, "destroy" | "remove" | "delete") {
                    self.deny(Kind::Destructive, format!("{name} {verb} destroys what it built"));
                } else if !read {
                    self.ask(Kind::Write, format!("{name} {verb} creates or changes infrastructure"));
                }
            }
            "tfsec" | "tflint" | "terraform-docs" | "checkov" | "infracost" => {}
            _ => {}
        }
    }

    // ----- clouds -----

    fn cloud(&mut self, name: &str, args: &[Val], st: &mut State) {
        let o = getopt(args, "", &["profile", "region", "output", "query", "endpoint-url", "project", "account", "subscription", "format", "filter", "configuration", "impersonate-service-account", "ca-bundle", "cli-input-json", "cli-input-yaml", "cli-read-timeout", "cli-connect-timeout", "color", "debug_", "no-verify-ssl_"]);
        let words: Vec<String> = o.ops.iter().filter_map(|v| v.exact()).map(str::to_string).collect();
        let w = |i: usize| words.get(i).map(|s| s.as_str()).unwrap_or("");
        let with_decrypt = args.iter().any(|a| a.is("--with-decryption") || a.is("--show-secrets") || a.is("--reveal"));
        // Verbs that hand back a credential, wherever they stand.
        if words.iter().any(|x| secret_verb(x)) || (words.iter().any(|x| x == "get-parameter" || x == "get-parameters" || x == "get-parameters-by-path") && with_decrypt) {
            self.deny(Kind::Credential, format!("{name} {} returns a credential or secret value", words.iter().find(|x| secret_verb(x) || x.starts_with("get-param")).cloned().unwrap_or_default()));
            return;
        }
        match name {
            "aws" => {
                let svc = w(0);
                match svc {
                    "s3" => match w(1) {
                        "ls" | "presign" | "help" | "" => {}
                        "rm" | "rb" => self.deny(Kind::Destructive, "aws s3 rm deletes objects"),
                        "cp" | "mv" | "sync" => {
                            let ops = &words[2.min(words.len())..];
                            let dest = ops.last().cloned().unwrap_or_default();
                            if w(1) == "mv" {
                                self.deny(Kind::Destructive, "aws s3 mv removes the source");
                            } else if dest.starts_with("s3://") {
                                self.ask(Kind::Network, "aws s3 uploads to a bucket");
                            } else if !dest.is_empty() {
                                self.write_path(&Val::lit(dest), st, "aws s3 writes");
                            }
                        }
                        _ => self.ask(Kind::Network, "aws s3 changes a bucket"),
                    },
                    "configure" => {
                        if !matches!(w(1), "get" | "list" | "list-profiles") {
                            self.ask(Kind::Credential, "aws configure changes the stored credentials");
                        }
                    }
                    "sts" | "iam" | "organizations" | "kms" | "secretsmanager" | "ssm" => self.cloud_verb(name, &words, 1),
                    _ => self.cloud_verb(name, &words, 1),
                }
            }
            "gcloud" | "gsutil" | "az" | "bq" => {
                if name == "gsutil" {
                    match w(0) {
                        "ls" | "cat" | "stat" | "du" | "hash" | "version" | "help" => {}
                        "rm" | "rb" => self.deny(Kind::Destructive, "gsutil rm deletes objects"),
                        _ => self.ask(Kind::Network, "gsutil changes a bucket"),
                    }
                    return;
                }
                if words.iter().any(|x| x == "print-access-token" || x == "print-identity-token" || x == "get-access-token" || x == "access" && words.iter().any(|y| y == "versions")) {
                    self.deny(Kind::Credential, format!("{name} prints a token or secret"));
                    return;
                }
                if words.windows(2).any(|p| p[0] == "keys" && p[1] == "create") || words.iter().any(|x| x == "create-for-rbac") {
                    self.deny(Kind::Credential, format!("{name} creates a service account key or credential"));
                    return;
                }
                if words.iter().any(|x| destroying_verb(x)) {
                    self.deny(Kind::Destructive, format!("{name} {} deletes cloud resources", words.iter().find(|x| destroying_verb(x)).cloned().unwrap_or_default()));
                } else if words.iter().any(|x| reading_verb(x)) || words.is_empty() {
                    // reads
                } else if matches!(w(0), "auth" | "config" | "init" | "login" | "logout" | "account") && !words.iter().any(|x| matches!(x.as_str(), "list" | "show" | "get-value")) {
                    self.ask(Kind::Credential, format!("{name} {} changes the login or configuration", w(0)));
                } else {
                    self.ask(Kind::Network, format!("{name} changes cloud resources"));
                }
            }
            "crane" | "gcrane" | "oras" | "regctl" | "cosign" => {
                let verb = w(0);
                match verb {
                    "ls" | "config" | "manifest" | "digest" | "export" | "catalog" | "pull" | "blob" | "version" | "help" | "validate" | "verify" | "tree" | "inspect" | "show" | "describe" | "resolve" | "discover" | "fetch" | "list" | "" | "completion" | "triangulate" | "dockerfile" | "tag_" => {
                        if verb == "export" || verb == "pull" {
                            if let Some(d) = words.last() {
                                if words.len() > 2 {
                                    self.write_path(&Val::lit(d.clone()), st, &format!("{name} writes"));
                                }
                            }
                        }
                    }
                    "delete" | "rm" | "untag" => self.deny(Kind::Destructive, format!("{name} {verb} deletes an image or tag")),
                    "login" | "logout" | "auth" => self.ask(Kind::Credential, format!("{name} {verb} changes the registry login")),
                    _ => self.ask(Kind::Publishing, format!("{name} {verb} writes to a registry")),
                }
            }
            "rclone" | "azcopy" | "s3cmd" | "mc" => {
                let verb = w(0);
                match verb {
                    "ls" | "lsd" | "lsl" | "lsf" | "lsjson" | "cat" | "size" | "tree" | "check" | "md5sum" | "sha1sum" | "about" | "version" | "listremotes" | "help" | "stat" | "du" | "diff" | "find" | "" | "info" => {}
                    "delete" | "deletefile" | "purge" | "rmdir" | "rmdirs" | "cleanup" | "rm" | "rb" | "remove" | "dedupe" | "move" | "moveto" | "mv" => self.deny(Kind::Destructive, format!("{name} {verb} deletes or moves data")),
                    "config" => {
                        if !matches!(w(1), "show" | "file" | "paths" | "providers" | "dump") {
                            self.ask(Kind::Credential, format!("{name} config changes stored remotes"));
                        } else if w(1) == "show" || w(1) == "dump" {
                            self.ask(Kind::Credential, format!("{name} config {} prints remotes with secrets", w(1)));
                        }
                    }
                    _ => self.ask(Kind::Network, format!("{name} {verb} copies data to or from a remote")),
                }
            }
            _ => {
                if words.iter().any(|x| destroying_verb(x)) {
                    self.deny(Kind::Destructive, format!("{name} {} deletes cloud resources", words.iter().find(|x| destroying_verb(x)).cloned().unwrap_or_default()));
                } else if words.is_empty() || words.iter().any(|x| reading_verb(x)) || matches!(w(0), "logs" | "status" | "whoami" | "version" | "help" | "info" | "tail") {
                } else {
                    self.ask(Kind::Network, format!("{name} {} changes cloud resources or deploys", w(0)));
                }
            }
        }
    }

    fn cloud_verb(&mut self, name: &str, words: &[String], at: usize) {
        let verb = words.get(at).map(|s| s.as_str()).unwrap_or("");
        if destroying_verb(verb) {
            self.deny(Kind::Destructive, format!("{name} {} {verb} deletes cloud resources", words.first().cloned().unwrap_or_default()));
        } else if reading_verb(verb) || verb.is_empty() {
        } else {
            self.ask(Kind::Network, format!("{name} {} {verb} changes cloud resources", words.first().cloned().unwrap_or_default()));
        }
    }

    // ----- gh -----

    fn gh(&mut self, name: &str, args: &[Val], st: &mut State) {
        let o = getopt(args, "RqtHXfFLwB", &["repo", "jq", "template", "header", "method", "field", "raw-field", "input", "hostname", "cache", "preview_"]);
        let words: Vec<String> = o.ops.iter().filter_map(|v| v.exact()).map(str::to_string).collect();
        let g = |i: usize| words.get(i).map(|s| s.as_str()).unwrap_or("");
        let (group, verb) = (g(0), g(1));
        match group {
            "api" => {
                let method = o.val("X").or_else(|| o.val("method")).map(|m| m.s.to_ascii_uppercase());
                let has_fields = o.val("f").is_some() || o.val("F").is_some() || o.val("field").is_some() || o.val("raw-field").is_some() || o.val("input").is_some();
                match method.as_deref() {
                    Some("DELETE") => self.deny(Kind::Destructive, format!("{name} api DELETE removes a resource")),
                    Some("GET") | Some("HEAD") | None if !has_fields => {}
                    _ => self.ask(Kind::Network, format!("{name} api changes a resource")),
                }
                if let Some(f) = o.val("input") {
                    let f = f.clone();
                    if f.s != "-" {
                        self.read_path(&f, st, "sends");
                    }
                }
            }
            "auth" => match verb {
                "token" => self.deny(Kind::Credential, format!("{name} auth token prints the login token")),
                "status" => {
                    if args.iter().any(|a| a.is("-t") || a.is("--show-token")) {
                        self.deny(Kind::Credential, format!("{name} auth status --show-token prints the login token"));
                    }
                }
                _ => self.ask(Kind::Credential, format!("{name} auth {verb} changes the login")),
            },
            "pr" | "mr" => match verb {
                "view" | "list" | "diff" | "checks" | "status" | "ls" | "show" | "comments" | "" => {}
                "merge" => self.deny(Kind::Destructive, format!("{name} {group} merge merges into the base branch")),
                "checkout" | "co" => {}
                _ => self.ask(Kind::Network, format!("{name} {group} {verb} changes a pull request")),
            },
            "issue" | "release" | "run" | "workflow" | "gist" | "repo" | "label" | "project" | "cache" | "variable" | "secret" | "ruleset" | "ssh-key" | "gpg-key" | "codespace" | "extension" | "alias" | "config" | "org" | "environment" | "deploy-key" => {
                match verb {
                    "view" | "list" | "ls" | "status" | "diff" | "watch" | "show" | "" | "get" | "download" | "checks" | "logs" | "comments" | "search" | "browse_" => {
                        if verb == "download" {
                            self.write_path(&Val::lit("./x"), st, &format!("{name} {group} download writes"));
                        }
                    }
                    "clone" => self.write_path(&Val::lit("./x"), st, &format!("{name} repo clone writes")),
                    "delete" | "remove" | "rm" | "archive" | "unarchive_" => self.deny(Kind::Destructive, format!("{name} {group} {verb} deletes or archives")),
                    "set" | "add" | "create" | "edit" | "upload" | "rerun" | "cancel" | "run" | "enable" | "disable" | "fork" | "sync" | "rename" | "comment" | "close" | "reopen" | "pin" | "unpin" | "transfer" | "lock" | "unlock" | "install" | "upgrade" | "import" | "develop" | "link" | "unlink" | "stop" | "ssh" | "cp" | "ports" | "rebuild" => {
                        let kind = if matches!(group, "secret" | "variable" | "ssh-key" | "gpg-key" | "deploy-key") { Kind::Credential } else { Kind::Network };
                        self.ask(kind, format!("{name} {group} {verb} changes the remote"));
                    }
                    _ => self.ask(Kind::Unknown, format!("unknown {name} {group} {verb}")),
                }
            }
            "search" | "status" | "browse" | "completion" | "help" | "version" | "attestation" | "copilot" | "" => {
                if group == "browse" {
                    self.ask(Kind::Code, format!("{name} browse opens a browser"));
                }
            }
            _ => {
                if matches!(name, "hub" | "tea" | "bitbucket" | "jira" | "linear") && !matches!(group, "list" | "view" | "show") {
                    self.ask(Kind::Network, format!("{name} {group} talks to a remote service"));
                } else if name == "glab" || name == "gh" {
                    self.ask(Kind::Unknown, format!("unknown {name} command: {group}"));
                }
            }
        }
    }

    // ----- services and packages -----

    fn service(&mut self, name: &str, args: &[Val]) {
        let words: Vec<&str> = args.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
        let user = args.iter().any(|a| a.is("--user") || a.is("-u_"));
        let verb = if name == "service" || name == "rc-service" || name == "sv" { words.get(1).copied().unwrap_or("") } else { words.first().copied().unwrap_or("") };
        match verb {
            "status" | "show" | "list-units" | "list-unit-files" | "list-timers" | "list-sockets" | "list-dependencies" | "is-active" | "is-enabled" | "is-failed" | "cat" | "get-default" | "help" | "list-jobs" | "list-machines" | "show-environment" | "" | "avail" | "check" | "pid" | "version" | "tail" | "reread_" | "stat" | "list" => {}
            "poweroff" | "reboot" | "halt" | "kexec" | "suspend" | "hibernate" | "hybrid-sleep" | "suspend-then-hibernate" | "rescue" | "emergency" | "default" | "isolate" | "soft-reboot" => {
                self.deny(Kind::Destructive, format!("{name} {verb} powers the machine off or isolates it"));
            }
            _ => {
                let kind = if user { Kind::Write } else { Kind::Privilege };
                self.ask(kind, format!("{name} {verb} {} changes a service", words.get(1).copied().unwrap_or("")));
            }
        }
    }

    fn packages(&mut self, name: &str, args: &[Val]) {
        let words: Vec<&str> = args.iter().filter_map(|v| v.exact()).collect();
        let reads = words.iter().any(|w| matches!(*w, "list" | "search" | "show" | "info" | "policy" | "depends" | "rdepends" | "madison" | "query" | "-l" | "-L" | "-S_" | "-s" | "-p" | "--list" | "--status" | "--listfiles" | "--search" | "-Q" | "-Qs" | "-Qi" | "-Ql" | "-Ss" | "-Si" | "--version" | "-V" | "-qa" | "-q" | "-ql" | "-qi" | "-qf" | "--query" | "list-installed" | "provides" | "whatprovides" | "repolist" | "check-update" | "history" | "--help" | "-h" | "version" | "-Qe" | "-Qq" | "-Qm" | "-Qdt" | "-Sl" | "-F" | "files"))
            && !words.iter().any(|w| matches!(*w, "install" | "remove" | "purge" | "upgrade" | "update" | "dist-upgrade" | "full-upgrade" | "autoremove" | "add" | "del" | "-S" | "-R" | "-U" | "-i" | "-r" | "-P" | "erase" | "reinstall" | "-Syu" | "-Sy" | "-Su" | "-Rns" | "-Rs"));
        if !reads {
            self.ask(Kind::Privilege, format!("{name} installs, upgrades or removes system software"));
        }
    }

    // ----- databases -----

    fn database(&mut self, name: &str, args: &[Val], io: &Io, st: &mut State) {
        match name {
            "dropdb" | "dropuser" => {
                self.deny(Kind::Destructive, format!("{name} drops a database or role"));
                return;
            }
            "createdb" | "createuser" | "initdb" | "pg_ctl" | "pg_upgrade" | "vacuumdb" | "reindexdb" => {
                self.ask(Kind::Write, format!("{name} creates or changes a database"));
                return;
            }
            "pg_dump" | "pg_dumpall" | "mysqldump" | "mongodump" | "pg_basebackup" => {
                let o = getopt(args, "hUdpfFoPtTnNzZjvwWRSe", &["file", "host", "port", "username", "dbname", "out", "uri", "format", "schema", "table"]);
                for k in ["f", "file", "out", "o"] {
                    if let Some(f) = o.val(k) {
                        let f = f.clone();
                        self.write_path(&f, st, &format!("{name} writes"));
                    }
                }
                // A dump is a read of everything: of the database and, for the passwords, of nothing local.
                return;
            }
            "pg_restore" | "mongorestore" | "migrate" | "goose" | "sqitch" | "flyway" | "liquibase" | "prisma" | "drizzle-kit" | "sequelize" | "typeorm" | "knex" | "alembic" | "atlas" | "dbt" => {
                let words: Vec<&str> = args.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
                let read = words.first().is_some_and(|w| matches!(*w, "status" | "version" | "validate" | "info" | "history" | "current" | "heads" | "branches" | "show" | "list" | "ls" | "compile" | "docs" | "parse" | "debug" | "format" | "generate" | "lint" | "check" | "diff" | "inspect" | "help" | "--help" | "studio_"));
                if matches!(words.first().copied(), Some("drop") | Some("clean") | Some("reset") | Some("destroy") | Some("down") | Some("migrate:undo") | Some("migrate:undo:all") | Some("rollback")) || words.iter().any(|w| *w == "--force-reset" || *w == "--accept-data-loss") || args.iter().any(|a| a.is("--accept-data-loss") || a.is("--force-reset")) {
                    self.deny(Kind::Destructive, format!("{name} resets or drops data"));
                } else if !read {
                    self.ask(Kind::Write, format!("{name} changes a database"));
                }
                return;
            }
            _ => {}
        }
        // The statement the client is given: an argument, a file or standard input.
        let lite = matches!(name, "sqlite3" | "sqlite" | "duckdb" | "litecli");
        let lite_args: Vec<Val> = if lite {
            // These take their options with a single dash and a word: `-header`, `-cmd SQL`.
            let mut keep: Vec<Val> = Vec::new();
            let mut it = args.iter();
            while let Some(a) = it.next() {
                match a.exact() {
                    Some("-cmd") | Some("-c") => {
                        if let Some(v) = it.next() {
                            keep.push(Val::lit("-e"));
                            keep.push(v.clone());
                        }
                    }
                    Some("-init") | Some("-separator") | Some("-newline") | Some("-nullvalue") | Some("-vfs") | Some("-mmap") | Some("-A") | Some("-cmd_") => {
                        it.next();
                    }
                    Some(t) if t.starts_with('-') && t.len() > 1 => {}
                    _ => keep.push(a.clone()),
                }
            }
            keep
        } else {
            Vec::new()
        };
        let args: &[Val] = if lite { &lite_args } else { args };
        let o = getopt(args, "cefhUdpPqxwWtTvVFoRrXAHzZ", &["command", "execute", "query", "file", "host", "port", "username", "user", "dbname", "database", "eval", "init", "cmd", "password", "uri", "connection-string", "output"]);
        let mut texts: Vec<String> = Vec::new();
        let mut unknown = false;
        for k in ["c", "command", "e", "execute", "q", "query", "eval", "cmd", "init"] {
            if let Some(v) = o.val(k) {
                if v.has_unknown() {
                    unknown = true;
                }
                texts.push(v.s.clone());
            }
        }
        for k in ["f", "file"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                self.read_path(&f, st, "reads");
                if let Some(text) = self.resolve(&f, st).and_then(|a| self.wrote.get(&a).cloned()) {
                    texts.push(text);
                } else if let Some(abs) = self.resolve(&f, st) {
                    if let Some(files) = self.ctx.files.clone() {
                        self.impure = true;
                        if let Some(t) = files.read(&abs, 256 * 1024) {
                            texts.push(t);
                        }
                    }
                }
            }
        }
        for k in ["o", "output"] {
            if let Some(f) = o.val(k) {
                let f = f.clone();
                if name != "clickhouse-client" {
                    self.write_path(&f, st, &format!("{name} writes"));
                }
            }
        }
        match &io.stdin {
            Stdin::Text(v) => {
                if v.has_unknown() {
                    unknown = true;
                }
                texts.push(v.s.clone());
            }
            Stdin::Pipe { literal: Some(t), .. } => texts.push(t.clone()),
            Stdin::Pipe { literal: None, .. } => unknown = true,
            Stdin::File(f) => {
                let f = f.clone();
                self.read_path(&f, st, "reads");
                if let Some(abs) = self.resolve(&f, st) {
                    let t = self.wrote.get(&abs).cloned().or_else(|| {
                        let files = self.ctx.files.clone()?;
                        self.impure = true;
                        files.read(&abs, 256 * 1024)
                    });
                    match t {
                        Some(t) => texts.push(t),
                        None => unknown = true,
                    }
                } else {
                    unknown = true;
                }
            }
            Stdin::Inherit => {}
        }
        // Positional statements: `sqlite3 db 'SQL'`, `duckdb db 'SQL'`, `redis-cli GET key`.
        let positional: Vec<&Val> = o.all_ops().collect();
        match name {
            "sqlite3" | "sqlite" | "duckdb" | "litecli" => {
                if let Some(db) = positional.first() {
                    let db = (*db).clone();
                    if !db.is(":memory:") && !db.s.is_empty() {
                        // The file is opened for writing when the statement writes; read otherwise.
                        self.read_path(&db, st, "opens");
                        let writes_db = positional.get(1).is_some() || !texts.is_empty();
                        let _ = writes_db;
                    }
                }
                for p in positional.iter().skip(1) {
                    if p.has_unknown() {
                        unknown = true;
                    }
                    texts.push(p.s.clone());
                }
            }
            "redis-cli" | "valkey-cli" | "rediscli" => {
                let words: Vec<String> = positional.iter().map(|v| v.s.to_ascii_uppercase()).collect();
                self.redis(&words, positional.iter().any(|v| v.has_unknown()), !texts.is_empty() || matches!(io.stdin, Stdin::Pipe { .. } | Stdin::Text(_) | Stdin::File(_)));
                return;
            }
            "mongosh" | "mongo" => {
                for t in &texts {
                    self.mongo(t);
                }
                if texts.is_empty() {
                    self.ask(Kind::Code, format!("{name} opens a shell on a database"));
                }
                return;
            }
            _ => {}
        }
        if unknown {
            self.ask(Kind::Code, format!("{name} runs statements it cannot read"));
        }
        if texts.is_empty() {
            if !unknown {
                self.ask(Kind::Code, format!("{name} opens a session on a database"));
            }
            return;
        }
        for t in &texts {
            match sql::scan(t) {
                Sql::Reads => {}
                Sql::Writes(what) => self.ask(Kind::Write, format!("{name} runs a statement that changes data ({what})")),
                Sql::Destroys(what) => self.deny(Kind::Destructive, format!("{name} runs a statement that destroys data ({what})")),
                Sql::Runs(what) => self.deny(Kind::Code, format!("{name} runs a statement that runs a program or reads a file ({what})")),
                Sql::Unreadable => self.ask(Kind::Unparsed, format!("cannot read the statements given to {name}")),
            }
        }
    }

    fn redis(&mut self, words: &[String], unknown: bool, from_input: bool) {
        let Some(cmd) = words.iter().find(|w| !w.starts_with('-') && !w.chars().all(|c| c.is_ascii_digit())).cloned() else {
            if from_input {
                self.ask(Kind::Code, "redis-cli runs commands it cannot read");
            } else {
                self.ask(Kind::Code, "redis-cli opens a session");
            }
            return;
        };
        if unknown {
            self.ask(Kind::Code, "redis-cli with a command it cannot read");
            return;
        }
        match cmd.as_str() {
            "GET" | "MGET" | "KEYS" | "SCAN" | "HGET" | "HGETALL" | "HMGET" | "HKEYS" | "HVALS" | "HLEN" | "LRANGE" | "LLEN" | "LINDEX" | "SMEMBERS" | "SCARD" | "SISMEMBER" | "ZRANGE" | "ZCARD" | "ZSCORE" | "ZRANK" | "TTL" | "PTTL" | "TYPE" | "EXISTS" | "INFO" | "DBSIZE" | "PING" | "STRLEN" | "XRANGE" | "XLEN" | "XREAD" | "XINFO" | "MEMORY" | "SLOWLOG" | "LASTSAVE" | "TIME" | "ECHO" | "COMMAND" | "OBJECT" | "SSCAN" | "HSCAN" | "ZSCAN" | "PUBSUB" | "ROLE" | "LOLWUT" | "GETRANGE" | "BITCOUNT" | "GEOPOS" | "GEODIST" | "GEORADIUS_RO" | "-V" | "--VERSION" => {}
            "CLIENT" | "CONFIG" => {
                let sub = words.iter().skip_while(|w| **w != cmd).nth(1).map(|s| s.as_str()).unwrap_or("");
                if cmd == "CONFIG" && sub == "GET" || cmd == "CLIENT" && matches!(sub, "LIST" | "INFO" | "GETNAME" | "ID") {
                } else if cmd == "CONFIG" {
                    self.deny(Kind::Code, "redis CONFIG SET/REWRITE can write files and load modules");
                } else {
                    self.ask(Kind::Write, "redis CLIENT changes connections");
                }
            }
            "FLUSHALL" | "FLUSHDB" | "SHUTDOWN" | "DEBUG" | "MODULE" | "SLAVEOF" | "REPLICAOF" | "SAVE_" | "BGREWRITEAOF_" | "FAILOVER" | "ACL" | "MIGRATE" => {
                self.deny(Kind::Destructive, format!("redis {cmd} destroys data or reconfigures the server"));
            }
            "EVAL" | "EVALSHA" | "SCRIPT" | "FUNCTION" | "FCALL" => self.ask(Kind::Code, format!("redis {cmd} runs a script")),
            _ => self.ask(Kind::Write, format!("redis {cmd} changes data")),
        }
    }

    fn mongo(&mut self, text: &str) {
        let t = text.to_ascii_lowercase();
        if t.contains("dropdatabase") || t.contains(".drop(") || t.contains("dropcollection") || t.contains("deletemany") || t.contains(".remove(") || t.contains("deleteone") && false || t.contains("shutdownserver") || t.contains("dropallusers") || t.contains("dropuser") || t.contains("dropindex") {
            self.deny(Kind::Destructive, "mongo drops or removes data");
        } else if t.contains("$where") || t.contains("eval(") || t.contains("runcommand") || t.contains("load(") || t.contains("require(") || t.contains("child_process") || t.contains("run(") {
            self.deny(Kind::Code, "mongo runs server-side or shell code");
        } else if t.contains("insert") || t.contains("update") || t.contains("save(") || t.contains("replaceone") || t.contains("bulkwrite") || t.contains("findoneandupdate") || t.contains("findandmodify") || t.contains("createindex") || t.contains("createcollection") || t.contains("$out") || t.contains("$merge") || t.contains("grant") || t.contains("createuser") || t.contains("rename") || t.contains("deleteone") {
            self.ask(Kind::Write, "mongo changes data");
        }
    }

    // ----- the Hanzo CLI -----

    fn hanzo(&mut self, name: &str, args: &[Val], st: &mut State) {
        // The program's own options come first: `hanzo --as admin auth token`.
        let skip = super::wrap::skip_opts(args, "", &["as", "org", "env", "profile", "api", "url", "project", "config", "token"]);
        let rest = args.get(skip..).unwrap_or(&[]);
        let words: Vec<&str> = rest.iter().filter_map(|v| v.exact()).filter(|t| !t.starts_with('-')).collect();
        let first = words.first().copied().unwrap_or("");
        if first == "kms" || first == "secret" || first == "secrets" {
            let verbs: Vec<&str> = words.iter().skip(1).copied().collect();
            let get = verbs.iter().any(|v| matches!(*v, "get" | "read" | "reveal" | "export" | "dump" | "show" | "decrypt" | "fetch" | "pull" | "print" | "cat" | "env" | "run" | "inject"));
            let del = verbs.iter().any(|v| matches!(*v, "delete" | "rm" | "remove" | "destroy" | "revoke" | "purge"));
            let list = verbs.iter().any(|v| matches!(*v, "list" | "ls" | "status" | "version" | "help" | "whoami" | "audit" | "history")) && !get;
            if get {
                self.deny(Kind::Credential, format!("{name} {first} reads a secret value"));
            } else if del {
                self.deny(Kind::Destructive, format!("{name} {first} deletes a secret"));
            } else if !list {
                self.ask(Kind::Credential, format!("{name} {first} changes secrets"));
            }
            return;
        }
        let sub = words.get(1).copied().unwrap_or("");
        match first {
            "" | "version" | "help" | "status" | "whoami" | "doctor" | "list" | "ls" | "get" | "show" | "logs" | "ps" | "models" | "search" | "info" => {}
            "login" | "logout" | "token" => self.ask(Kind::Credential, format!("{name} {first} changes or prints the login")),
            "auth" => {
                if !matches!(sub, "status" | "whoami" | "" | "list" | "help" | "info" | "show" | "check") {
                    self.ask(Kind::Credential, format!("{name} auth {sub} changes or prints the login"));
                }
            }
            _ => {
                if name == "luxd" || name == "lux" {
                    self.ask(Kind::Unknown, format!("{name} {first} runs or changes a node or network"));
                } else {
                    self.ask(Kind::Unknown, format!("{name} {first} is a command this classifier does not know"));
                }
            }
        }
        let _ = st;
    }
}
