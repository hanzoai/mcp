//! What one request carries besides its arguments: the token a client's
//! `notifications/cancelled` fires, and the channel `notifications/progress` goes out on.
//!
//! A library caller (Dev, `ffi.rs`) passes [`Ctx::default()`]: never cancelled, no progress, so a
//! tool behaves exactly as it does without one. The stdio transport builds one per request.

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct Ctx {
    cancel: CancellationToken,
    progress: Option<Progress>,
}

/// The client's `progressToken` and the line writer its notifications go to.
#[derive(Clone)]
struct Progress {
    token: Value,
    out: UnboundedSender<String>,
}

impl Ctx {
    pub fn new(cancel: CancellationToken) -> Self {
        Self { cancel, progress: None }
    }

    /// Progress notifications for `token` go to `out`, one JSON-RPC line each.
    pub fn with_progress(mut self, token: Value, out: UnboundedSender<String>) -> Self {
        self.progress = Some(Progress { token, out });
        self
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Resolves when the client cancels this request; never, for a library caller.
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await
    }

    /// Whether the client asked for progress, so a tool can skip the work of reporting it.
    pub fn wants_progress(&self) -> bool {
        self.progress.is_some()
    }

    /// Report `progress` (which must increase from one call to the next), with an optional
    /// `total` and a line for the person watching. A no-op when no progress was asked for.
    pub fn progress(&self, progress: f64, total: Option<f64>, message: Option<&str>) {
        let Some(p) = &self.progress else { return };
        let mut params = json!({ "progressToken": p.token, "progress": progress });
        if let Some(total) = total {
            params["total"] = json!(total);
        }
        if let Some(message) = message {
            params["message"] = json!(message);
        }
        let line = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": params });
        let _ = p.out.send(line.to_string());
    }
}

impl jsonrpc_core::Metadata for Ctx {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn the_default_is_never_cancelled_and_reports_nothing() {
        let ctx = Ctx::default();
        assert!(!ctx.is_cancelled());
        assert!(!ctx.wants_progress());
        ctx.progress(1.0, None, Some("ignored"));
        assert!(tokio::time::timeout(Duration::from_millis(50), ctx.cancelled()).await.is_err());
    }

    #[tokio::test]
    async fn a_cancel_reaches_every_clone() {
        let token = CancellationToken::new();
        let ctx = Ctx::new(token.clone());
        let clone = ctx.clone();
        token.cancel();
        assert!(ctx.is_cancelled() && clone.is_cancelled());
        tokio::time::timeout(Duration::from_millis(50), clone.cancelled()).await.expect("resolves once cancelled");
    }

    #[test]
    fn progress_is_one_json_rpc_notification_per_call() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let ctx = Ctx::new(CancellationToken::new()).with_progress(json!(7), tx);
        assert!(ctx.wants_progress());

        ctx.progress(1.0, None, None);
        let first: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(first, json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progressToken": 7, "progress": 1.0 } }));

        ctx.progress(2.0, Some(4.0), Some("halfway"));
        let second: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(second["params"], json!({ "progressToken": 7, "progress": 2.0, "total": 4.0, "message": "halfway" }));
        assert!(rx.try_recv().is_err(), "one line per call");
    }

    #[test]
    fn a_string_token_is_echoed_as_a_string() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        Ctx::default().with_progress(json!("abc"), tx).progress(1.0, None, None);
        let line: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(line["params"]["progressToken"], "abc");
    }

    #[test]
    fn progress_after_the_writer_is_gone_does_not_panic() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        Ctx::default().with_progress(json!(1), tx).progress(1.0, None, None);
    }
}
