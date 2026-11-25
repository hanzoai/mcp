use anyhow::{ensure, Result};
use hanzo_mcp::{zap, MCPTool, ToolResult};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

pub struct Share {
    provider: String,
    tab: String,
    url: Url,
}

#[derive(Deserialize)]
struct Page {
    title: String,
    url: String,
    markdown: String,
}

impl Share {
    pub const NAME: &str = "read_shared_page";

    pub fn new(provider: String, tab: String, url: Url) -> Result<Self> {
        ensure!(
            provider.starts_with(zap::BROWSER)
                && provider
                    .rsplit('/')
                    .next()
                    .is_some_and(|id| id.starts_with("chrome-")),
            "expected a Chrome ZAP browser ID"
        );
        let id = tab
            .strip_prefix("tab-")
            .and_then(|id| id.parse::<u32>().ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| anyhow::anyhow!("expected a browser tab ID"))?;
        ensure!(
            matches!(url.scheme(), "https" | "http") && url.host().is_some(),
            "expected an HTTP(S) page URL"
        );
        Ok(Self {
            provider,
            tab: format!("tab-{id}"),
            url,
        })
    }

    fn page(&self, response: &str) -> Result<ToolResult> {
        // The extension reads the document URL and content in the same execution.
        let page: Page = serde_json::from_str(response)?;
        ensure!(
            Url::parse(&page.url)? == self.url,
            "the tab left the authorized URL"
        );
        Ok(ToolResult::ok(json!({
            "title": page.title, "url": page.url, "markdown": page.markdown
        })))
    }
}

#[async_trait::async_trait]
impl MCPTool for Share {
    fn name(&self) -> &str {
        Self::NAME
    }

    fn description(&self) -> &str {
        "Read the single browser page authorized by the user on their Hanzo device."
    }

    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {}, "additionalProperties": false})
    }

    async fn execute(&self, params: Value) -> Result<ToolResult> {
        ensure!(
            params.as_object().is_some_and(|map| map.is_empty()),
            "this tool takes no arguments"
        );
        let response = zap::route(
            &self.provider,
            "hanzo.read",
            &[("tabId".into(), self.tab.clone())],
            Duration::from_secs(30),
        )
        .await?;
        Ok(self.page(&response).unwrap_or_else(|_| {
            ToolResult::err(
                "The authorized page is unavailable or the tab left its authorized URL.",
            )
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn share_is_pinned_to_the_authorized_page() {
        let share = Share::new(
            "browser/device/chrome-test".into(),
            "tab-42".into(),
            "https://example.com/path?account=1".parse().unwrap(),
        )
        .unwrap();
        assert!(share.execute(json!({"tab_id": "tab-99"})).await.is_err());
        assert!(share.page(r#"{"title":"","url":"https://example.com/path?account=1","markdown":"authorized"}"#).unwrap().success);
        for url in [
            "https://other.example/path?account=1",
            "https://example.com/path?account=2",
        ] {
            assert!(share
                .page(&json!({"title":"","url":url,"markdown":"private"}).to_string())
                .is_err());
        }
        assert!(share.page("ERR:No tab").is_err());
    }
}
