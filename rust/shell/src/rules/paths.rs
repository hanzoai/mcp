//! The policy over paths: what reading, writing and removing a place costs. Every rule asks
//! these, so changing the policy changes it for every command.

use crate::path::{Place, Sense};
use crate::val::Val;
use crate::verdict::Kind;
use crate::walk::{State, Walker};

/// Files whose write gives somebody access or removes a protection: never run from here.
fn grants(secret: &str) -> bool {
    secret.contains("authorized") || secret.contains("sudo") || secret.contains("password") || secret.contains("host key")
}

impl Walker<'_> {
    pub(crate) fn sense(&self, v: &Val, st: &State) -> Sense {
        self.lay.sense(v, st.cwd.as_deref())
    }

    /// The absolute, normalized path `v` names, when it is known.
    pub(crate) fn resolve(&self, v: &Val, st: &State) -> Option<String> {
        let t = v.exact()?;
        if t.starts_with('/') {
            return Some(crate::path::normalize(t));
        }
        let cwd = st.cwd.as_deref()?;
        Some(crate::path::normalize(&format!("{cwd}/{t}")))
    }

    /// The contents of the file are read (not only its name): a credential may not be.
    pub(crate) fn read_path(&mut self, v: &Val, st: &State, what: &str) {
        let s = self.sense(v, st);
        let shown = v.show();
        if let Some(secret) = s.secret {
            // A certificate and a key share the extension: a person decides.
            if secret.starts_with("a pem file") {
                self.ask(Kind::Credential, format!("{what} {secret}: {shown}"));
            } else {
                self.deny(Kind::Credential, format!("{what} {secret}: {shown}"));
            }
            return;
        }
        match s.place {
            Place::Disk => self.ask(Kind::Unknown, format!("{what} a raw device: {shown}")),
            Place::Net => self.ask(Kind::Network, format!("{what} a network connection: {shown}")),
            _ => {}
        }
    }

    /// Reads a file whose contents are used, not shown (a certificate, a key given to a tool).
    pub(crate) fn use_path(&mut self, v: &Val, st: &State, what: &str) {
        let s = self.sense(v, st);
        if let Some(secret) = s.secret {
            self.ask(Kind::Credential, format!("{what} {secret}: {}", v.show()));
        }
    }

    /// The file is created or overwritten.
    pub(crate) fn write_path(&mut self, v: &Val, st: &State, what: &str) {
        let s = self.sense(v, st);
        let shown = v.show();
        if s.place == Place::System {
            self.deny(Kind::Privilege, format!("{what} a system path: {shown}"));
            return;
        }
        if let Some(secret) = s.secret {
            if grants(secret) || s.touchy.is_some_and(|t| t.contains("authorized")) {
                self.deny(Kind::Credential, format!("{what} {secret}: {shown}"));
            } else {
                self.ask(Kind::Credential, format!("{what} {secret}: {shown}"));
            }
            return;
        }
        match s.place {
            Place::Disk => self.deny(Kind::Destructive, format!("{what} a disk device: {shown}")),
            Place::System => self.deny(Kind::Privilege, format!("{what} a system path: {shown}")),
            Place::Root | Place::Broad => self.deny(Kind::Destructive, format!("{what} {shown}, the top of a tree")),
            Place::Net => self.ask(Kind::Network, format!("{what} a network connection: {shown}")),
            Place::Work | Place::Anchor | Place::Temp | Place::TempRoot | Place::Null => {
                if let Some(t) = s.touchy {
                    self.ask(Kind::Write, format!("{what} {t}: {shown}"));
                }
            }
            Place::Home | Place::HomeSub | Place::Outside => {
                if s.climbs {
                    self.ask(Kind::Traversal, format!("{what} a path that climbs out of the workspace: {shown}"));
                } else if let Some(t) = s.touchy {
                    self.ask(Kind::Write, format!("{what} {t}: {shown}"));
                } else {
                    self.ask(Kind::Write, format!("{what} outside the workspace: {shown}"));
                }
            }
            Place::Unknown => self.ask(Kind::Write, format!("{what} a path it cannot resolve: {shown}")),
        }
    }

    /// The file or tree is deleted.
    pub(crate) fn remove_path(&mut self, v: &Val, st: &State, recursive: bool) {
        let s = self.sense(v, st);
        let shown = v.show();
        if matches!(s.place, Place::System | Place::Disk) {
            self.deny(Kind::Privilege, format!("removes a system path: {shown}"));
            return;
        }
        let wipes = v.glob && self.glob_wipes(v, st);
        match s.place {
            Place::Root | Place::Broad | Place::Home | Place::TempRoot => {
                if recursive || wipes {
                    self.deny(Kind::Destructive, format!("recursive remove of {shown}, the top of a tree"));
                }
            }
            Place::Anchor => {
                if recursive || wipes {
                    self.deny(Kind::Destructive, format!("recursive remove of the whole workspace: {shown}"));
                }
            }
            Place::Work | Place::Temp | Place::Null => {
                if wipes && recursive {
                    self.deny(Kind::Destructive, format!("recursive remove of everything in a directory: {shown}"));
                } else if s.secret.is_some() {
                    self.ask(Kind::Destructive, format!("removes {}: {shown}", s.secret.unwrap_or("a credential")));
                } else if recursive && is_git(&v.s) {
                    self.deny(Kind::Destructive, format!("removes the repository's history: {shown}"));
                }
            }
            Place::HomeSub | Place::Outside => {
                if (recursive || wipes) && self.ctx.remote {
                    // Another machine has no workspace to measure against: a person decides.
                    self.ask(Kind::Destructive, format!("recursive remove on a remote host: {shown}"));
                } else if recursive || wipes {
                    self.deny(Kind::Destructive, format!("recursive remove outside the workspace: {shown}"));
                } else {
                    self.ask(Kind::Write, format!("removes outside the workspace: {shown}"));
                }
            }
            Place::Net => {}
            Place::Unknown => {
                if recursive {
                    self.ask(Kind::Destructive, format!("recursive remove of a path it cannot resolve: {shown}"));
                }
            }
            Place::System | Place::Disk => {}
        }
    }

    /// A glob in the last component of a path whose directory is a place nobody should empty.
    fn glob_wipes(&self, v: &Val, st: &State) -> bool {
        let t = v.s.trim_end_matches('/');
        let (dir, base) = match t.rfind('/') {
            Some(i) => (&t[..=i], &t[i + 1..]),
            None => ("./", t),
        };
        if !base.contains(['*', '?', '[']) {
            return false;
        }
        let d = self.sense(&Val::lit(dir.to_string()), st);
        matches!(d.place, Place::Anchor | Place::Home | Place::Root | Place::Broad | Place::TempRoot | Place::System)
    }

}

fn is_git(path: &str) -> bool {
    path.trim_end_matches('/').rsplit('/').next() == Some(".git")
}
