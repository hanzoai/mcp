//! A private home for a test process that embeds the ZAP router: its own
//! `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` and `HOME`, set before anything reads
//! them, so no test ever reaches the router (or the browser) of the user
//! running it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Set up the private home once, stand for router in it, and return it.
pub fn home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = tempfile::Builder::new().prefix("zap-test-rs-").tempdir().unwrap().keep();
        for (var, sub) in [("XDG_RUNTIME_DIR", "run"), ("XDG_STATE_HOME", "state"), ("HOME", "home")] {
            let p = dir.join(sub);
            std::fs::create_dir_all(&p).unwrap();
            std::env::set_var(var, &p);
        }
        std::env::set_var("BROWSER_BACKEND", "auto");
        // The door binds the port the pairing names: pin it to one nothing
        // else wants, never a well-known port a real extension sweeps.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let pair = zapd::pair::Pairing { port, key: [7; 32] };
        let state = dir.join("state/zap");
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(&state).unwrap();
        let file = state.join("pair");
        std::fs::write(&file, format!("{}\n", pair.code())).unwrap();
        std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        hanzo_mcp::zap::seat();
        dir
    })
}
