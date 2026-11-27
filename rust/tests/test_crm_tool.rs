//! Integration and mock-HTTP tests for the native `crm` MCP tool.
//!
//! Exercises all 13 `crm` actions, `deals` -> `opportunities` normalization,
//! graceful 404 fallback to Hanzo Base (`/v1/base/collections/{object}/records`),
//! `X-Org-Id` header forwarding, invalid object/arg rejection, missing auth,
//! and HIP-0300 tool surface compliance.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use hanzo_mcp::tools::crm_tool::{normalize_crm_object, CRM_ACTIONS, CRM_OBJECTS};
use hanzo_mcp::tools::CrmTool;
use hanzo_mcp::{MCPTool, ToolRegistry, CANONICAL_TOOLS, LEGACY_ALIASES};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

/// Recorded HTTP request seen by the loopback mock server.
#[derive(Clone, Debug)]
struct SeenRequest {
    method: String,
    target: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Option<Value>,
}

/// Canned HTTP response from the mock server.
#[derive(Clone, Debug)]
struct MockResponse {
    status: u16,
    body: Option<Value>,
}

impl MockResponse {
    fn json(status: u16, body: Value) -> Self {
        Self { status, body: Some(body) }
    }
    fn no_content() -> Self {
        Self { status: 204, body: None }
    }
}

fn parse_query(target: &str) -> (String, HashMap<String, String>) {
    let Some((path, qs)) = target.split_once('?') else {
        return (target.to_string(), HashMap::new());
    };
    let mut map = HashMap::new();
    for pair in qs.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(k), percent_decode(v));
    }
    (path.to_string(), map)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                    if let Ok(b) = u8::from_str_radix(hex, 16) {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                }
                out.push(bytes[i]);
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Spawn a mock HTTP server that serves `responses` in sequence (or invokes a router closure)
/// and records every incoming request.
async fn spawn_mock<F>(handler: F) -> (String, Arc<Mutex<Vec<SeenRequest>>>)
where
    F: Fn(&SeenRequest) -> MockResponse + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let seen = Arc::new(Mutex::new(Vec::<SeenRequest>::new()));
    let seen_bg = seen.clone();
    let handler = Arc::new(handler);

    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let seen_req = seen_bg.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                let head = loop {
                    let Ok(n) = sock.read(&mut buf).await else { return };
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&buf[..n]);
                    if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };

                let header_text = String::from_utf8_lossy(&raw[..head]).to_string();
                let mut lines = header_text.lines();
                let start = lines.next().unwrap_or_default();
                let mut parts = start.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let target = parts.next().unwrap_or_default().to_string();
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                    .collect();

                let content_len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                while raw.len() < head + content_len {
                    let Ok(n) = sock.read(&mut buf).await else { return };
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }

                let body = if content_len > 0 {
                    serde_json::from_slice::<Value>(&raw[head..head + content_len]).ok()
                } else {
                    None
                };

                let (path, query) = parse_query(&target);
                let req = SeenRequest {
                    method,
                    target,
                    path,
                    query,
                    headers,
                    body,
                };
                let resp = handler(&req);
                seen_req.lock().unwrap().push(req);

                let reason = match resp.status {
                    200 => "OK",
                    201 => "Created",
                    204 => "No Content",
                    400 => "Bad Request",
                    403 => "Forbidden",
                    404 => "Not Found",
                    500 => "Internal Server Error",
                    _ => "OK",
                };
                let payload = resp
                    .body
                    .map(|v| serde_json::to_string(&v).unwrap())
                    .unwrap_or_default();
                let wire = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp.status,
                    reason,
                    payload.len(),
                    payload
                );
                let _ = sock.write_all(wire.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });

    (base, seen)
}

#[tokio::test]
async fn all_13_crm_actions_hit_expected_endpoints_and_payloads() {
    let (base, seen) = spawn_mock(|req| match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/crm/objects") => MockResponse::json(200, json!({ "objects": CRM_OBJECTS })),
        ("GET", "/v1/crm/search") => MockResponse::json(200, json!({ "hits": [{ "id": "p_1", "object": "people" }] })),
        ("GET", "/v1/crm/records/people") => MockResponse::json(200, json!({ "items": [{ "id": "p_1" }], "total": 1 })),
        ("GET", "/v1/crm/records/opportunities/opp_42") => MockResponse::json(200, json!({ "id": "opp_42", "stage": "qualified" })),
        ("POST", "/v1/crm/records/companies") => MockResponse::json(201, json!({ "id": "co_9", "name": "Hanzo AI" })),
        ("PATCH", "/v1/crm/records/people/p_1") => MockResponse::json(200, json!({ "id": "p_1", "title": "Co-CEO" })),
        ("DELETE", "/v1/crm/records/tasks/t_7") => MockResponse::no_content(),
        ("POST", "/v1/crm/records/people/merge") => MockResponse::json(200, json!({ "merged_into": "p_2" })),
        ("POST", "/v1/crm/deals/opp_42/stage") => MockResponse::json(200, json!({ "id": "opp_42", "stage": "closed_won" })),
        ("POST", "/v1/crm/timeline") => MockResponse::json(201, json!({ "id": "act_1", "kind": "call" })),
        ("GET", "/v1/crm/analytics") => MockResponse::json(200, json!({ "pipeline_value": 1250000 })),
        ("POST", "/v1/crm/ai/assist") => MockResponse::json(200, json!({ "suggestion": "Follow up tomorrow" })),
        ("POST", "/v1/marketing/mail") => MockResponse::json(200, json!({ "sent": true, "message_id": "msg_1" })),
        _ => MockResponse::json(404, json!({ "error": "unexpected route", "path": req.path })),
    })
    .await;

    let tool = CrmTool::with_endpoint(base, Some("sk-crm-test".into()), Some("hanzo".into()));

    // 1. objects
    let r = tool.execute(json!({ "action": "objects" })).await.unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"], json!({ "tool": "crm", "action": "objects" }));

    // 2. search (verifies deals -> opportunities normalization in objects filter)
    let r = tool
        .execute(json!({ "action": "search", "q": "acme", "objects": ["people", "deals"], "limit": 10 }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["hits"][0]["id"], "p_1");

    // 3. list
    let r = tool
        .execute(json!({
            "action": "list",
            "object": "people",
            "filter": "status='active'",
            "sort": "-created",
            "search": "ada",
            "page": 2,
            "per_page": 25,
            "expand": "company"
        }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["total"], 1);

    // 4. get (using `deals` alias -> `opportunities` + `include`)
    let r = tool
        .execute(json!({ "action": "get", "object": "deals", "id": "opp_42", "expand": "company,owner", "include": "timeline,notes" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["id"], "opp_42");

    // 5. create (wrapped in `{"record": ..., "key": ...}` for /v1/crm/records/:object)
    let r = tool
        .execute(json!({ "action": "create", "object": "companies", "data": { "name": "Hanzo AI", "domain": "hanzo.ai" }, "key": "domain" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["id"], "co_9");

    // 6. update (wrapped in `{"record": ...}` for /v1/crm/records/:object/:id)
    let r = tool
        .execute(json!({ "action": "update", "object": "people", "id": "p_1", "data": { "title": "Co-CEO" } }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["title"], "Co-CEO");

    // 7. delete (204 No Content synthesizes deleted payload)
    let r = tool
        .execute(json!({ "action": "delete", "object": "tasks", "id": "t_7" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"], json!({ "deleted": true, "object": "tasks", "id": "t_7" }));

    // 8. merge
    let r = tool
        .execute(json!({
            "action": "merge",
            "object": "people",
            "source_id": "p_1",
            "target_id": "p_2",
            "fields": { "email": "primary@hanzo.ai" }
        }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["merged_into"], "p_2");

    // 9. move_stage
    let r = tool
        .execute(json!({ "action": "move_stage", "id": "opp_42", "stage": "closed_won", "next_step": "Kickoff", "note": "Signed MSA" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["stage"], "closed_won");

    // 10. log_activity (normalizes person->person_id etc. and outbound->out)
    let r = tool
        .execute(json!({
            "action": "log_activity",
            "kind": "call",
            "subject": "Discovery call",
            "body": "Discussed enterprise rollout",
            "person": "p_1",
            "company": "co_9",
            "opportunity": "opp_42",
            "candidate": "cand_3",
            "direction": "outbound",
            "channel": "phone"
        }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["id"], "act_1");

    // 11. analytics (with pipeline query param)
    let r = tool
        .execute(json!({ "action": "analytics", "pipeline": "sales", "period": "30d", "object": "deals" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["pipeline_value"], 1250000);

    // 12. ai_assist
    let r = tool
        .execute(json!({
            "action": "ai_assist",
            "mode": "draft_email",
            "prompt": "Follow up after demo",
            "object": "deals",
            "record_id": "opp_42",
            "model": "enso-auto"
        }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["suggestion"], "Follow up tomorrow");

    // 13. send_email
    let r = tool
        .execute(json!({
            "action": "send_email",
            "to": "founder@acme.io",
            "subject": "Next steps",
            "body": "Great speaking today.",
            "person": "p_1",
            "in_reply_to": "<msg1@acme.io>"
        }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["data"]["sent"], true);

    // Verify wire-level requests recorded by mock server.
    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 13, "expected exactly 13 HTTP calls");

    // Every request carried Bearer auth and default X-Org-Id.
    for req in &reqs {
        assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer sk-crm-test"));
        assert_eq!(req.headers.get("x-org-id").map(String::as_str), Some("hanzo"));
    }

    // Spot-check query strings & JSON bodies against hanzo-inc/cloud contracts.
    assert_eq!(reqs[1].query.get("q").map(String::as_str), Some("acme"));
    assert_eq!(reqs[1].query.get("objects").map(String::as_str), Some("people,opportunities"));
    assert_eq!(reqs[1].query.get("limit").map(String::as_str), Some("10"));

    assert_eq!(reqs[2].query.get("filter").map(String::as_str), Some("status='active'"));
    assert_eq!(reqs[2].query.get("sort").map(String::as_str), Some("-created"));
    assert_eq!(reqs[2].query.get("search").map(String::as_str), Some("ada"));
    assert_eq!(reqs[2].query.get("page").map(String::as_str), Some("2"));
    assert_eq!(reqs[2].query.get("per_page").map(String::as_str), Some("25"));
    assert_eq!(reqs[2].query.get("expand").map(String::as_str), Some("company"));

    assert_eq!(reqs[3].query.get("expand").map(String::as_str), Some("company,owner"));
    assert_eq!(reqs[3].query.get("include").map(String::as_str), Some("timeline,notes"));
    assert_eq!(
        reqs[4].body,
        Some(json!({ "record": { "name": "Hanzo AI", "domain": "hanzo.ai" }, "key": "domain" }))
    );
    assert_eq!(reqs[5].body, Some(json!({ "record": { "title": "Co-CEO" } })));
    assert_eq!(
        reqs[7].body,
        Some(json!({ "source_id": "p_1", "target_id": "p_2", "fields": { "email": "primary@hanzo.ai" } }))
    );
    assert_eq!(
        reqs[8].body,
        Some(json!({ "stage": "closed_won", "next_step": "Kickoff", "note": "Signed MSA" }))
    );
    assert_eq!(
        reqs[9].body,
        Some(json!({
            "kind": "call",
            "subject": "Discovery call",
            "body": "Discussed enterprise rollout",
            "person_id": "p_1",
            "company_id": "co_9",
            "opportunity_id": "opp_42",
            "candidate_id": "cand_3",
            "direction": "out",
            "channel": "phone"
        }))
    );
    assert_eq!(reqs[10].query.get("pipeline").map(String::as_str), Some("sales"));
    assert_eq!(reqs[10].query.get("object").map(String::as_str), Some("opportunities"));
    assert_eq!(reqs[10].query.get("period").map(String::as_str), Some("30d"));
    assert_eq!(
        reqs[11].body,
        Some(json!({
            "mode": "draft_email",
            "prompt": "Follow up after demo",
            "object": "opportunities",
            "record_id": "opp_42",
            "model": "enso-auto"
        }))
    );
    assert_eq!(
        reqs[12].body,
        Some(json!({
            "to": "founder@acme.io",
            "subject": "Next steps",
            "body": "Great speaking today.",
            "person": "p_1",
            "in_reply_to": "<msg1@acme.io>"
        }))
    );
}

#[tokio::test]
async fn graceful_base_fallback_on_404_for_all_crud_actions() {
    let (base, seen) = spawn_mock(|req| {
        if req.path.starts_with("/v1/crm/records/") {
            return MockResponse::json(404, json!({ "error": "not found" }));
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/v1/base/collections/people/records") => {
                MockResponse::json(200, json!({ "items": [{ "id": "pb_1" }], "page": 1, "perPage": 15 }))
            }
            ("GET", "/v1/base/collections/companies/records/co_1") => {
                MockResponse::json(200, json!({ "id": "co_1", "name": "Fallback Co" }))
            }
            ("POST", "/v1/base/collections/opportunities/records") => {
                MockResponse::json(201, json!({ "id": "opp_99", "title": "Enterprise" }))
            }
            ("PATCH", "/v1/base/collections/tasks/records/t_1") => {
                MockResponse::json(200, json!({ "id": "t_1", "done": true }))
            }
            ("DELETE", "/v1/base/collections/notes/records/n_1") => MockResponse::no_content(),
            _ => MockResponse::json(404, json!({ "error": "still missing" })),
        }
    })
    .await;

    let tool = CrmTool::with_endpoint(base, Some("sk-fallback".into()), None);

    // list fallback (maps per_page -> perPage for Base)
    let r = tool
        .execute(json!({ "action": "list", "object": "people", "page": 1, "per_page": 15 }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"]["fallback"], "base");
    assert_eq!(r.content["data"]["items"][0]["id"], "pb_1");

    // get fallback
    let r = tool
        .execute(json!({ "action": "get", "object": "companies", "id": "co_1" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"]["fallback"], "base");
    assert_eq!(r.content["data"]["name"], "Fallback Co");

    // create fallback (with `deals` -> `opportunities`)
    let r = tool
        .execute(json!({ "action": "create", "object": "deals", "data": { "title": "Enterprise" } }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"]["fallback"], "base");
    assert_eq!(r.content["data"]["id"], "opp_99");

    // update fallback
    let r = tool
        .execute(json!({ "action": "update", "object": "tasks", "id": "t_1", "data": { "done": true } }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"]["fallback"], "base");
    assert_eq!(r.content["data"]["done"], true);

    // delete fallback
    let r = tool
        .execute(json!({ "action": "delete", "object": "notes", "id": "n_1" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], true, "{}", r.content);
    assert_eq!(r.content["meta"]["fallback"], "base");
    assert_eq!(r.content["data"], json!({ "deleted": true, "object": "notes", "id": "n_1" }));

    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 10, "each CRUD op hits /v1/crm then falls back to /v1/base");
    assert_eq!(reqs[0].path, "/v1/crm/records/people");
    assert_eq!(reqs[1].path, "/v1/base/collections/people/records");
    assert_eq!(reqs[1].query.get("perPage").map(String::as_str), Some("15"));
    assert_eq!(reqs[4].path, "/v1/crm/records/opportunities");
    assert_eq!(reqs[4].body, Some(json!({ "record": { "title": "Enterprise" } })));
    assert_eq!(reqs[5].path, "/v1/base/collections/opportunities/records");
    assert_eq!(reqs[5].body, Some(json!({ "title": "Enterprise" })));
    assert_eq!(reqs[6].body, Some(json!({ "record": { "done": true } })));
    assert_eq!(reqs[7].body, Some(json!({ "done": true })));
}

#[tokio::test]
async fn non_404_error_does_not_trigger_base_fallback() {
    let (base, seen) = spawn_mock(|_req| {
        MockResponse::json(403, json!({ "error": { "message": "forbidden by org policy" } }))
    })
    .await;

    let tool = CrmTool::with_endpoint(base, Some("sk-test".into()), None);
    let r = tool
        .execute(json!({ "action": "list", "object": "people" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "UPSTREAM");
    assert!(r.content["error"]["message"].as_str().unwrap().contains("403: forbidden by org policy"));
    assert_eq!(seen.lock().unwrap().len(), 1, "must not retry against Base on 403");
}

#[tokio::test]
async fn org_header_forwarding_and_override() {
    let (base, seen) = spawn_mock(|_req| MockResponse::json(200, json!({ "ok": true }))).await;
    let tool = CrmTool::with_endpoint(base, Some("sk-org".into()), Some("default-org".into()));

    // Default org
    let r1 = tool.execute(json!({ "action": "objects" })).await.unwrap();
    assert_eq!(r1.content["ok"], true);

    // Explicit per-call org overrides default
    let r2 = tool.execute(json!({ "action": "objects", "org": "lux-labs" })).await.unwrap();
    assert_eq!(r2.content["ok"], true);

    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].headers.get("x-org-id").map(String::as_str), Some("default-org"));
    assert_eq!(reqs[1].headers.get("x-org-id").map(String::as_str), Some("lux-labs"));
}

#[tokio::test]
async fn invalid_objects_ids_modes_and_missing_auth_are_rejected_without_network() {
    let (base, seen) = spawn_mock(|_req| MockResponse::json(200, json!({}))).await;
    let tool = CrmTool::with_endpoint(base.clone(), Some("sk-test".into()), None);

    // Unknown / malicious objects rejected before HTTP
    for bad_obj in ["users", "invoices", "../secrets", "people/1", ""] {
        let r = tool
            .execute(json!({ "action": "list", "object": bad_obj }))
            .await
            .unwrap();
        assert_eq!(r.content["ok"], false, "expected rejection for {bad_obj:?}");
        assert_eq!(r.content["error"]["code"], "INVALID_ARGS");
    }

    // Invalid object inside search `objects` filter
    let r = tool
        .execute(json!({ "action": "search", "q": "test", "objects": "people,bogus" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Path-traversal record id rejected
    for bad_id in ["../admin", "a/b", "id with space", "id?x=1"] {
        let r = tool
            .execute(json!({ "action": "get", "object": "people", "id": bad_id }))
            .await
            .unwrap();
        assert_eq!(r.content["ok"], false, "expected rejection for id {bad_id:?}");
        assert_eq!(r.content["error"]["code"], "INVALID_ARGS");
    }

    // Invalid ai_assist mode rejected
    let r = tool
        .execute(json!({ "action": "ai_assist", "mode": "hallucinate", "prompt": "hi" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Invalid org slug rejected
    let r = tool
        .execute(json!({ "action": "objects", "org": "bad org\r\nX-Injected: 1" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Self-merge rejected
    let r = tool
        .execute(json!({ "action": "merge", "object": "people", "source_id": "p_1", "target_id": "p_1" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Unknown action rejected
    let r = tool.execute(json!({ "action": "drop_table" })).await.unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Unlinked log_activity rejected
    let r = tool
        .execute(json!({ "action": "log_activity", "kind": "call", "subject": "No entity" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Invalid log_activity direction rejected
    let r = tool
        .execute(json!({ "action": "log_activity", "kind": "call", "person_id": "p_1", "direction": "sideways" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Multi-recipient send_email rejected (/v1/marketing/mail takes one string address)
    let r = tool
        .execute(json!({ "action": "send_email", "to": ["a@b.co", "c@d.co"], "subject": "Hi", "body": "Body" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // ai_assist ask without prompt & mismatched object/record_id rejected
    let r = tool
        .execute(json!({ "action": "ai_assist", "mode": "ask" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    let r = tool
        .execute(json!({ "action": "ai_assist", "mode": "summarize", "object": "people" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Invalid analytics pipeline rejected
    let r = tool
        .execute(json!({ "action": "analytics", "pipeline": "invalid" }))
        .await
        .unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "INVALID_ARGS");

    // Missing API key rejected
    let unauth = CrmTool::with_endpoint(base, None, None);
    let r = unauth.execute(json!({ "action": "objects" })).await.unwrap();
    assert_eq!(r.content["ok"], false);
    assert_eq!(r.content["error"]["code"], "NO_API_KEY");

    assert_eq!(seen.lock().unwrap().len(), 0, "zero HTTP requests should have been sent");
}

#[test]
fn all_13_canonical_objects_plus_deals_alias_pass_allowlist() {
    assert_eq!(CRM_OBJECTS.len(), 13);
    assert!(CRM_OBJECTS.contains(&"applications"));
    for obj in CRM_OBJECTS {
        assert_eq!(normalize_crm_object(obj).unwrap(), *obj);
    }
    assert_eq!(normalize_crm_object("deals").unwrap(), "opportunities");
    assert_eq!(CRM_ACTIONS.len(), 13);
}

#[tokio::test]
async fn tool_surface_stays_19_canonical_and_crm_executes_via_registry_and_hanzo() {
    static ENV_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
    let _guard = ENV_LOCK.lock().await;

    // 1. Default surface remains the exact 19 HIP-0300 canonical tools.
    let registry = ToolRegistry::with_defaults();
    let defs = registry.get_definitions();
    let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(names.as_slice(), CANONICAL_TOOLS);
    assert_eq!(defs.len(), 19);
    assert!(LEGACY_ALIASES.contains(&"crm"));
    assert!(!names.contains(&"crm"), "crm must not leak into default 19-tool tools/list");

    // 2. Explicit --tools restriction can expose `crm` with its full schema.
    let mut restricted = ToolRegistry::with_defaults();
    restricted.restrict(["crm"]).unwrap();
    let rdefs = restricted.get_definitions();
    assert_eq!(rdefs.len(), 1);
    assert_eq!(rdefs[0]["name"], "crm");
    assert_eq!(rdefs[0]["inputSchema"]["required"], json!(["action"]));

    // 3. Direct registry execution (`crm`) and platform routing (`hanzo(resource="crm")`)
    //    both reach HANZO_API_URL with Bearer auth and X-Org-Id.
    let (base, seen) = spawn_mock(|req| match req.path.as_str() {
        "/v1/crm/objects" => MockResponse::json(200, json!({ "objects": CRM_OBJECTS })),
        _ => MockResponse::json(404, json!({})),
    })
    .await;

    let prev_base = std::env::var("HANZO_API_BASE").ok();
    let prev_url = std::env::var("HANZO_API_URL").ok();
    let prev_key = std::env::var("HANZO_API_KEY").ok();
    let prev_org = std::env::var("HANZO_ORG").ok();

    std::env::remove_var("HANZO_API_BASE");
    std::env::set_var("HANZO_API_URL", &base);
    std::env::set_var("HANZO_API_KEY", "sk-reg-test");
    std::env::remove_var("HANZO_ORG");

    let reg = ToolRegistry::with_defaults();
    let direct = reg
        .execute("crm", json!({ "action": "objects", "org": "hanzo-inc" }))
        .await
        .unwrap();
    let via_hanzo = reg
        .execute(
            "hanzo",
            json!({ "resource": "crm", "action": "objects", "org": "zoo-labs" }),
        )
        .await
        .unwrap();

    // Restore env before asserting.
    match prev_base {
        Some(v) => std::env::set_var("HANZO_API_BASE", v),
        None => std::env::remove_var("HANZO_API_BASE"),
    }
    match prev_url {
        Some(v) => std::env::set_var("HANZO_API_URL", v),
        None => std::env::remove_var("HANZO_API_URL"),
    }
    match prev_key {
        Some(v) => std::env::set_var("HANZO_API_KEY", v),
        None => std::env::remove_var("HANZO_API_KEY"),
    }
    match prev_org {
        Some(v) => std::env::set_var("HANZO_ORG", v),
        None => std::env::remove_var("HANZO_ORG"),
    }

    assert_eq!(direct.content["ok"], true, "{}", direct.content);
    assert_eq!(via_hanzo.content["ok"], true, "{}", via_hanzo.content);

    let reqs = seen.lock().unwrap().clone();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].headers.get("x-org-id").map(String::as_str), Some("hanzo-inc"));
    assert_eq!(reqs[1].headers.get("x-org-id").map(String::as_str), Some("zoo-labs"));
}
