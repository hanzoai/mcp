//! This process's seat on the user's ZAP router, and the browsers it reaches.
//!
//! Every process that speaks ZAP embeds the router (`zapd::embed`) and the
//! kernel elects one of them by an fcntl lock on `<runtime>/zapd.lock`. The
//! winner owns `<runtime>/zapd.sock` and the browser door (127.0.0.1:9998, else
//! 21000-21007); `<runtime>` is `$XDG_RUNTIME_DIR/zap`. This process joins as
//! `mcp/hanzo-<pid>`, the seat Python hanzo-mcp takes, so either runtime can be
//! the router and either can call through the other's.
//!
//! A browser is a `browser/<host>/<engine>-<id>` node (the Hanzo extension).
//! A command is one ROUTE whose payload is the browser command body
//! ([`encode`]); the answer is the RESPONSE payload, UTF-8 JSON or
//! `ERR:<message>`.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;

/// The id prefix of every browser node.
pub const BROWSER: &str = "browser/";

/// What a caller is told when no browser is on the router.
pub const UNPAIRED: &str = "no browser on the ZAP router: open Chrome with the Hanzo extension (1.9.59+); \
it joins on its own. A sandboxed browser (snap, Flatpak) pairs instead: `hanzo-mcp pair`, then paste the code \
into the extension's popup";

/// Stand for router and take this process's seat, once.
pub fn seat() -> &'static zapd::Node {
    static NODE: OnceLock<zapd::Node> = OnceLock::new();
    NODE.get_or_init(|| {
        zapd::embed();
        zapd::Node::join(
            &format!("mcp/hanzo-{}", std::process::id()),
            zapd::frame::ROLE_CONSUMER,
            "hanzo",
            &[],
        )
    })
}

/// The browser command body, peer of the extension's `decodeCmd`.
///
/// Little-endian: `method` (u16 len + bytes), u16 param count, then each param
/// `key` (u16 len + bytes) + `value` (u32 len + bytes).
pub fn encode(method: &str, params: &[(String, String)]) -> Vec<u8> {
    let mut b = Vec::new();
    zapd::frame::put_str(&mut b, method);
    b.extend_from_slice(&(params.len() as u16).to_le_bytes());
    for (k, v) in params {
        zapd::frame::put_str(&mut b, k);
        b.extend_from_slice(&(v.len() as u32).to_le_bytes());
        b.extend_from_slice(v.as_bytes());
    }
    b
}

/// Every browser on the router.
pub async fn browsers() -> Result<Vec<zapd::Entry>> {
    let nodes = seat().nodes(Duration::from_secs(2)).await?;
    Ok(nodes.into_iter().filter(|n| n.id.starts_with(BROWSER)).collect())
}

/// The browser to address: `client_id` exactly, else the first whose engine or
/// name is `browser`, else the first one.
pub async fn resolve(browser: Option<&str>, client_id: Option<&str>) -> Result<Option<String>> {
    let found = browsers().await?;
    if let Some(id) = client_id {
        return Ok(found.into_iter().find(|b| b.id == id).map(|b| b.id));
    }
    if let Some(want) = browser {
        let want = want.to_lowercase();
        return Ok(found
            .into_iter()
            .find(|b| {
                let name = b.id.rsplit('/').next().unwrap_or("");
                let engine = b.desc.attrs.iter().find(|(k, _)| k == "engine").map(|(_, v)| v.as_str());
                engine == Some(want.as_str()) || name.split('-').next() == Some(want.as_str())
            })
            .map(|b| b.id));
    }
    Ok(found.into_iter().next().map(|b| b.id))
}

/// Send `method` to `provider` and return its answer as text.
pub async fn route(provider: &str, method: &str, params: &[(String, String)], timeout: Duration) -> Result<String> {
    let out = seat().call(provider, encode(method, params), timeout).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// A browser node as a caller sees it: `{id, role, brand, caps, attrs}`.
pub fn describe(e: &zapd::Entry) -> serde_json::Value {
    let role = match e.desc.role {
        zapd::frame::ROLE_PROVIDER => "provider",
        zapd::frame::ROLE_CONSUMER => "consumer",
        _ => "router",
    };
    let attrs: serde_json::Map<String, serde_json::Value> =
        e.desc.attrs.iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
    serde_json::json!({ "id": e.id, "role": role, "brand": e.desc.brand, "caps": e.desc.caps, "attrs": attrs })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_decode_cmd() {
        let b = encode("hanzo.act", &[("op".into(), "click".into()), ("selector".into(), "@e2".into())]);
        let mut want = vec![9, 0];
        want.extend_from_slice(b"hanzo.act");
        want.extend_from_slice(&[2, 0]);
        want.extend_from_slice(&[2, 0]);
        want.extend_from_slice(b"op");
        want.extend_from_slice(&[5, 0, 0, 0]);
        want.extend_from_slice(b"click");
        want.extend_from_slice(&[8, 0]);
        want.extend_from_slice(b"selector");
        want.extend_from_slice(&[3, 0, 0, 0]);
        want.extend_from_slice(b"@e2");
        assert_eq!(b, want);
    }
}
