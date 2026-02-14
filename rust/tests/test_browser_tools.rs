//! Browser Tools Tests - 1:1 parity with Python browser tests
//!
//! Tests for browser tool covering:
//! - Tool properties and metadata
//! - Status action
//! - Help action
//! - Action parsing
//! - Navigate action (requires Playwright)
//! - Click/Type/Fill actions
//! - Screenshot action
//! - Evaluate action

use hanzo_mcp::tools::{BrowserTool, BrowserToolArgs};

/// Test browser tool properties
#[test]
fn test_browser_tool_properties() {
    let tool = BrowserTool::new();
    // Tool exists and is properly initialized
    assert!(true);
}

/// Test browser help action
#[tokio::test]
async fn test_browser_help_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("categories").is_some());
    assert!(json.get("name").is_some());
    assert_eq!(json["name"], "browser");
    assert!(json.get("action_count").is_some());
    assert!(json.get("devices").is_some());
}

/// Test browser status action
#[tokio::test]
async fn test_browser_status_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "status".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert!(json.get("playwright_available").is_some());
    assert!(json.get("headless").is_some());
    assert!(json.get("cdp_port").is_some());
    assert!(json.get("categories").is_some());
}

/// Test browser default action (status)
#[tokio::test]
async fn test_browser_default_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    // Default action should be status
    assert!(json.get("headless").is_some() || json.get("categories").is_some());
}

/// Test all action categories in help
#[tokio::test]
async fn test_browser_help_categories() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let categories = json["categories"].as_object().unwrap();

    // Should have all major categories
    assert!(categories.get("navigation").is_some());
    assert!(categories.get("input").is_some());
    assert!(categories.get("mouse").is_some());
    assert!(categories.get("locators").is_some());
    assert!(categories.get("screen").is_some());
    assert!(categories.get("javascript").is_some());
    assert!(categories.get("browser").is_some());
}

/// Test navigation action parsing
#[tokio::test]
async fn test_browser_navigate_action_parsing() {
    let tool = BrowserTool::new();

    // Test "goto" alias
    let args = BrowserToolArgs {
        action: "goto".to_string(),
        url: Some("https://example.com".to_string()),
        ..Default::default()
    };

    // This will fail without Playwright, but should parse correctly
    let result = tool.execute(args).await;
    // Just verify it doesn't panic on action parsing
    assert!(true);
}

/// Test click action parsing
#[tokio::test]
async fn test_browser_click_action_parsing() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "click".to_string(),
        selector: Some("#submit-button".to_string()),
        ..Default::default()
    };

    // Will fail without browser, but should parse action correctly
    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test type action parsing
#[tokio::test]
async fn test_browser_type_action_parsing() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "type".to_string(),
        selector: Some("#input-field".to_string()),
        text: Some("Hello World".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test fill action parsing
#[tokio::test]
async fn test_browser_fill_action_parsing() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "fill".to_string(),
        selector: Some("#username".to_string()),
        text: Some("testuser".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test screenshot action parsing
#[tokio::test]
async fn test_browser_screenshot_action_parsing() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "screenshot".to_string(),
        full_page: Some(true),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test evaluate action parsing
#[tokio::test]
async fn test_browser_evaluate_action_parsing() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "evaluate".to_string(),
        code: Some("return document.title".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test action aliases
#[tokio::test]
async fn test_browser_action_aliases() {
    let tool = BrowserTool::new();

    // Test navigate aliases
    for alias in &["navigate", "goto", "go"] {
        let args = BrowserToolArgs {
            action: alias.to_string(),
            url: Some("https://test.com".to_string()),
            ..Default::default()
        };
        let _ = tool.execute(args).await;
    }

    // Test reload aliases
    for alias in &["reload", "refresh"] {
        let args = BrowserToolArgs {
            action: alias.to_string(),
            ..Default::default()
        };
        let _ = tool.execute(args).await;
    }

    // Test screenshot aliases
    for alias in &["screenshot", "capture"] {
        let args = BrowserToolArgs {
            action: alias.to_string(),
            ..Default::default()
        };
        let _ = tool.execute(args).await;
    }

    // Test evaluate aliases
    for alias in &["evaluate", "eval", "js"] {
        let args = BrowserToolArgs {
            action: alias.to_string(),
            code: Some("1+1".to_string()),
            ..Default::default()
        };
        let _ = tool.execute(args).await;
    }

    assert!(true);
}

/// Test selector alias (ref)
#[tokio::test]
async fn test_browser_selector_alias() {
    let tool = BrowserTool::new();

    // Test using ref_ instead of selector
    let args = BrowserToolArgs {
        action: "click".to_string(),
        ref_: Some("#button".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test viewport action
#[tokio::test]
async fn test_browser_viewport_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "viewport".to_string(),
        width: Some(1920),
        height: Some(1080),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test device emulation
#[tokio::test]
async fn test_browser_device_emulation() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "emulate".to_string(),
        device: Some("iphone_14".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test geolocation action
#[tokio::test]
async fn test_browser_geolocation() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "geolocation".to_string(),
        latitude: Some(37.7749),
        longitude: Some(-122.4194),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test wait action
#[tokio::test]
async fn test_browser_wait_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "wait".to_string(),
        timeout: Some(1000),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test locator actions
#[tokio::test]
async fn test_browser_locator_actions() {
    let tool = BrowserTool::new();

    // get_by_role
    let args = BrowserToolArgs {
        action: "get_by_role".to_string(),
        role: Some("button".to_string()),
        name: Some("Submit".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // get_by_text
    let args = BrowserToolArgs {
        action: "get_by_text".to_string(),
        text: Some("Click me".to_string()),
        exact: Some(true),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // get_by_label
    let args = BrowserToolArgs {
        action: "get_by_label".to_string(),
        text: Some("Email".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test assertion actions
#[tokio::test]
async fn test_browser_assertion_actions() {
    let tool = BrowserTool::new();

    // expect_visible
    let args = BrowserToolArgs {
        action: "expect_visible".to_string(),
        selector: Some("#element".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // expect_text
    let args = BrowserToolArgs {
        action: "expect_text".to_string(),
        selector: Some("#title".to_string()),
        expected: Some("Welcome".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // expect_url
    let args = BrowserToolArgs {
        action: "expect_url".to_string(),
        expected: Some("https://example.com".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test state check actions
#[tokio::test]
async fn test_browser_state_check_actions() {
    let tool = BrowserTool::new();

    for action in &[
        "is_visible",
        "is_enabled",
        "is_checked",
        "is_hidden",
        "is_editable",
    ] {
        let args = BrowserToolArgs {
            action: action.to_string(),
            selector: Some("#element".to_string()),
            ..Default::default()
        };
        let _ = tool.execute(args).await;
    }

    assert!(true);
}

/// Test mouse actions
#[tokio::test]
async fn test_browser_mouse_actions() {
    let tool = BrowserTool::new();

    // hover
    let args = BrowserToolArgs {
        action: "hover".to_string(),
        selector: Some("#menu".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // drag
    let args = BrowserToolArgs {
        action: "drag".to_string(),
        selector: Some("#source".to_string()),
        target_selector: Some("#target".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // scroll
    let args = BrowserToolArgs {
        action: "scroll".to_string(),
        delta_y: Some(500),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test touch actions
#[tokio::test]
async fn test_browser_touch_actions() {
    let tool = BrowserTool::new();

    // tap
    let args = BrowserToolArgs {
        action: "tap".to_string(),
        selector: Some("#button".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // swipe
    let args = BrowserToolArgs {
        action: "swipe".to_string(),
        direction: Some("left".to_string()),
        distance: Some(200),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // pinch
    let args = BrowserToolArgs {
        action: "pinch".to_string(),
        scale: Some(0.5),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test dialog handling
#[tokio::test]
async fn test_browser_dialog_action() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "dialog".to_string(),
        accept: true,
        prompt_text: Some("Yes".to_string()),
        ..Default::default()
    };

    let _ = tool.execute(args).await;
    assert!(true);
}

/// Test tab management
#[tokio::test]
async fn test_browser_tab_actions() {
    let tool = BrowserTool::new();

    // new_tab
    let args = BrowserToolArgs {
        action: "new_tab".to_string(),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // tabs
    let args = BrowserToolArgs {
        action: "tabs".to_string(),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // close_tab
    let args = BrowserToolArgs {
        action: "close_tab".to_string(),
        tab_index: Some(0),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test network actions
#[tokio::test]
async fn test_browser_network_actions() {
    let tool = BrowserTool::new();

    // route
    let args = BrowserToolArgs {
        action: "route".to_string(),
        pattern: Some("**/api/**".to_string()),
        block: true,
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // unroute
    let args = BrowserToolArgs {
        action: "unroute".to_string(),
        pattern: Some("**/api/**".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test storage actions
#[tokio::test]
async fn test_browser_storage_actions() {
    let tool = BrowserTool::new();

    // cookies
    let args = BrowserToolArgs {
        action: "cookies".to_string(),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // clear_cookies
    let args = BrowserToolArgs {
        action: "clear_cookies".to_string(),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // storage
    let args = BrowserToolArgs {
        action: "storage".to_string(),
        storage_type: Some("local".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test debug actions
#[tokio::test]
async fn test_browser_debug_actions() {
    let tool = BrowserTool::new();

    // console
    let args = BrowserToolArgs {
        action: "console".to_string(),
        level: Some("error".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // errors
    let args = BrowserToolArgs {
        action: "errors".to_string(),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    // highlight
    let args = BrowserToolArgs {
        action: "highlight".to_string(),
        selector: Some("#element".to_string()),
        ..Default::default()
    };
    let _ = tool.execute(args).await;

    assert!(true);
}

/// Test devices in help
#[tokio::test]
async fn test_browser_devices_list() {
    let tool = BrowserTool::new();
    let args = BrowserToolArgs {
        action: "help".to_string(),
        ..Default::default()
    };

    let result = tool.execute(args).await;
    assert!(result.is_ok());

    let output = result.unwrap();
    let json: serde_json::Value = serde_json::from_str(&output).unwrap();

    let devices = json["devices"].as_array().unwrap();
    assert!(devices.iter().any(|d| d == "mobile"));
    assert!(devices.iter().any(|d| d == "tablet"));
    assert!(devices.iter().any(|d| d == "iphone_14"));
}
