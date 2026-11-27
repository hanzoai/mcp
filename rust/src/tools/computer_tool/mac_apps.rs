//! Native macOS application connectors (Calendar, Reminders, Notes, Mail drafts,
//! Contacts, Shortcuts) executed safely via `osascript - <args>` (`on run argv`)
//! with ZERO string interpolation into AppleScript source.
//!
//! Mail is strictly draft-only: it composes and saves/displays a draft and NEVER
//! invokes `send`. Non-macOS targets compile cleanly and return a structured error.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
use super::macos::run_osascript;

#[derive(Debug, Clone, Default)]
pub struct MacAppRequest<'a> {
    pub op: &'a str,
    pub title: Option<&'a str>,
    pub text: Option<&'a str>,
    pub name: Option<&'a str>,
    pub query: Option<&'a str>,
    pub calendar: Option<&'a str>,
    pub list: Option<&'a str>,
    pub folder: Option<&'a str>,
    pub start: Option<&'a str>,
    pub end: Option<&'a str>,
    pub to: Option<&'a str>,
    pub cc: Option<&'a str>,
    pub days: i32,
    pub limit: usize,
}

#[cfg(not(target_os = "macos"))]
pub fn dispatch(_kind: &str, _req: &MacAppRequest<'_>) -> Result<Value> {
    Ok(json!({
        "success": false,
        "platform": std::env::consts::OS,
        "error": "mac_* native app actions are only available on macOS"
    }))
}

#[cfg(target_os = "macos")]
pub fn dispatch(kind: &str, req: &MacAppRequest<'_>) -> Result<Value> {
    match kind {
        "mac_calendar" => calendar(req),
        "mac_reminders" => reminders(req),
        "mac_notes" => notes(req),
        "mac_mail_draft" => mail_draft(req),
        "mac_contacts" => contacts(req),
        "mac_shortcuts" => shortcuts(req),
        other => Err(anyhow!("Unknown mac app action: {other}")),
    }
}

#[cfg(target_os = "macos")]
fn osascript_stdout(script: &str, args: &[&str]) -> Result<String> {
    let out = run_osascript(script, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(anyhow!("osascript failed: {stderr}"))
    }
}

#[cfg(target_os = "macos")]
fn calendar(req: &MacAppRequest<'_>) -> Result<Value> {
    let op = if req.op.is_empty() { "list" } else { req.op };
    match op {
        "list" => {
            let days = req.days.clamp(1, 60).to_string();
            let limit = req.limit.clamp(1, 200).to_string();
            let script = r#"
on run argv
    set numDays to (item 1 of argv) as integer
    set maxItems to (item 2 of argv) as integer
    set startDate to (current date)
    set time of startDate to 0
    set endDate to startDate + (numDays * days)
    set sep to ASCII character 31
    set outText to ""
    set n to 0
    tell application "Calendar"
        repeat with cal in calendars
            set calName to name of cal
            try
                set evs to (every event of cal whose start date ≥ startDate and start date ≤ endDate)
                repeat with ev in evs
                    if n ≥ maxItems then exit repeat
                    set s to summary of ev
                    set sd to (start date of ev) as string
                    set ed to (end date of ev) as string
                    set outText to outText & calName & sep & s & sep & sd & sep & ed & linefeed
                    set n to n + 1
                end repeat
            end try
            if n ≥ maxItems then exit repeat
        end repeat
    end tell
    return outText
end run
"#;
            let raw = osascript_stdout(script, &[&days, &limit])?;
            let events: Vec<Value> = raw
                .lines()
                .filter(|l| l.contains('\x1f'))
                .map(|l| {
                    let p: Vec<&str> = l.split('\x1f').collect();
                    json!({
                        "calendar": p.first().copied().unwrap_or(""),
                        "summary": p.get(1).copied().unwrap_or(""),
                        "start": p.get(2).copied().unwrap_or(""),
                        "end": p.get(3).copied().unwrap_or(""),
                    })
                })
                .collect();
            Ok(json!({ "success": true, "count": events.len(), "events": events }))
        }
        "create" => {
            let title = req
                .title
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("title required for mac_calendar create"))?;
            let start = req
                .start
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("start date string required for mac_calendar create"))?;
            let end = req.end.unwrap_or("");
            let cal = req.calendar.unwrap_or("");
            let notes = req.text.unwrap_or("");
            let script = r#"
on run argv
    set evTitle to item 1 of argv
    set startStr to item 2 of argv
    set endStr to item 3 of argv
    set calName to item 4 of argv
    set evNotes to item 5 of argv
    set startDate to date startStr
    if endStr is "" then
        set endDate to startDate + (60 * minutes)
    else
        set endDate to date endStr
    end if
    tell application "Calendar"
        if calName is "" then
            set targetCal to first calendar whose writable is true
        else
            set targetCal to first calendar whose name is calName
        end if
        tell targetCal
            make new event at end with properties {summary:evTitle, start date:startDate, end date:endDate, description:evNotes}
        end tell
        return name of targetCal
    end tell
end run
"#;
            let used_cal = osascript_stdout(script, &[title, start, end, cal, notes])?;
            Ok(json!({ "success": true, "created": true, "calendar": used_cal, "title": title }))
        }
        other => Err(anyhow!("Unknown mac_calendar op {other:?}; use 'list' or 'create'")),
    }
}

#[cfg(target_os = "macos")]
fn reminders(req: &MacAppRequest<'_>) -> Result<Value> {
    let op = if req.op.is_empty() { "list" } else { req.op };
    match op {
        "list" => {
            let list_name = req.list.unwrap_or("");
            let limit = req.limit.clamp(1, 200).to_string();
            let script = r#"
on run argv
    set wantedList to item 1 of argv
    set maxItems to (item 2 of argv) as integer
    set sep to ASCII character 31
    set outText to ""
    set n to 0
    tell application "Reminders"
        repeat with rlist in lists
            set lname to name of rlist
            if wantedList is "" or lname is wantedList then
                try
                    set itemsToRead to (every reminder of rlist whose completed is false)
                    repeat with r in itemsToRead
                        if n ≥ maxItems then exit repeat
                        set rname to name of r
                        set rdue to ""
                        try
                            if due date of r is not missing value then set rdue to (due date of r) as string
                        end try
                        set outText to outText & lname & sep & rname & sep & rdue & linefeed
                        set n to n + 1
                    end repeat
                end try
            end if
            if n ≥ maxItems then exit repeat
        end repeat
    end tell
    return outText
end run
"#;
            let raw = osascript_stdout(script, &[list_name, &limit])?;
            let items: Vec<Value> = raw
                .lines()
                .filter(|l| l.contains('\x1f'))
                .map(|l| {
                    let p: Vec<&str> = l.split('\x1f').collect();
                    json!({
                        "list": p.first().copied().unwrap_or(""),
                        "title": p.get(1).copied().unwrap_or(""),
                        "due": p.get(2).copied().unwrap_or(""),
                    })
                })
                .collect();
            Ok(json!({ "success": true, "count": items.len(), "reminders": items }))
        }
        "create" => {
            let title = req
                .title
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("title required for mac_reminders create"))?;
            let list_name = req.list.unwrap_or("");
            let body = req.text.unwrap_or("");
            let script = r#"
on run argv
    set rTitle to item 1 of argv
    set listName to item 2 of argv
    set rBody to item 3 of argv
    tell application "Reminders"
        if listName is "" then
            set targetList to default list
        else
            set targetList to first list whose name is listName
        end if
        tell targetList
            make new reminder with properties {name:rTitle, body:rBody}
        end tell
        return name of targetList
    end tell
end run
"#;
            let used = osascript_stdout(script, &[title, list_name, body])?;
            Ok(json!({ "success": true, "created": true, "list": used, "title": title }))
        }
        other => Err(anyhow!("Unknown mac_reminders op {other:?}; use 'list' or 'create'")),
    }
}

#[cfg(target_os = "macos")]
fn notes(req: &MacAppRequest<'_>) -> Result<Value> {
    let op = if req.op.is_empty() { "list" } else { req.op };
    match op {
        "list" => {
            let folder = req.folder.unwrap_or("");
            let limit = req.limit.clamp(1, 100).to_string();
            let script = r#"
on run argv
    set folderName to item 1 of argv
    set maxItems to (item 2 of argv) as integer
    set sep to ASCII character 31
    set outText to ""
    set n to 0
    tell application "Notes"
        if folderName is "" then
            set noteList to notes
        else
            set noteList to notes of folder folderName
        end if
        repeat with nt in noteList
            if n ≥ maxItems then exit repeat
            set nm to name of nt
            set md to (modification date of nt) as string
            set outText to outText & nm & sep & md & linefeed
            set n to n + 1
        end repeat
    end tell
    return outText
end run
"#;
            let raw = osascript_stdout(script, &[folder, &limit])?;
            let items: Vec<Value> = raw
                .lines()
                .filter(|l| l.contains('\x1f'))
                .map(|l| {
                    let p: Vec<&str> = l.split('\x1f').collect();
                    json!({
                        "title": p.first().copied().unwrap_or(""),
                        "modified": p.get(1).copied().unwrap_or(""),
                    })
                })
                .collect();
            Ok(json!({ "success": true, "count": items.len(), "notes": items }))
        }
        "read" => {
            let title = req
                .title
                .or(req.query)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("title required for mac_notes read"))?;
            let script = r#"
on run argv
    set needle to item 1 of argv
    tell application "Notes"
        set matched to (first note whose name contains needle)
        return (name of matched) & (ASCII character 31) & (plaintext of matched)
    end tell
end run
"#;
            let raw = osascript_stdout(script, &[title])?;
            let (found_title, body) = raw.split_once('\x1f').unwrap_or((title, raw.as_str()));
            Ok(json!({ "success": true, "title": found_title, "text": body }))
        }
        "create" => {
            let title = req
                .title
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("title required for mac_notes create"))?;
            let body = req.text.unwrap_or("");
            let folder = req.folder.unwrap_or("Notes");
            let script = r#"
on run argv
    set noteTitle to item 1 of argv
    set noteBody to item 2 of argv
    set folderName to item 3 of argv
    tell application "Notes"
        make new note at folder folderName with properties {name:noteTitle, body:noteBody}
    end tell
    return folderName
end run
"#;
            let used = osascript_stdout(script, &[title, body, folder])?;
            Ok(json!({ "success": true, "created": true, "folder": used, "title": title }))
        }
        other => Err(anyhow!("Unknown mac_notes op {other:?}; use 'list', 'read', or 'create'")),
    }
}

#[cfg(target_os = "macos")]
fn mail_draft(req: &MacAppRequest<'_>) -> Result<Value> {
    let to = req
        .to
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("to recipient required for mac_mail_draft"))?;
    let subject = req.title.unwrap_or("");
    let body = req.text.unwrap_or("");
    let cc = req.cc.unwrap_or("");
    // STRICTLY DRAFT-ONLY: creates a visible outgoing message in Mail.app, NEVER calls `send`.
    let script = r#"
on run argv
    set toAddr to item 1 of argv
    set subj to item 2 of argv
    set contentText to item 3 of argv
    set ccAddr to item 4 of argv
    tell application "Mail"
        set msg to make new outgoing message with properties {subject:subj, content:contentText, visible:true}
        tell msg
            make new to recipient at end of to recipients with properties {address:toAddr}
            if ccAddr is not "" then
                make new cc recipient at end of cc recipients with properties {address:ccAddr}
            end if
        end tell
        activate
    end tell
    return "draft_created"
end run
"#;
    osascript_stdout(script, &[to, subject, body, cc])?;
    Ok(json!({
        "success": true,
        "draft": true,
        "sent": false,
        "to": to,
        "subject": subject,
    }))
}

#[cfg(target_os = "macos")]
fn contacts(req: &MacAppRequest<'_>) -> Result<Value> {
    let query = req
        .query
        .or(req.name)
        .or(req.title)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| anyhow!("query required for mac_contacts"))?;
    let limit = req.limit.clamp(1, 50).to_string();
    let script = r#"
on run argv
    set needle to item 1 of argv
    set maxItems to (item 2 of argv) as integer
    set sep to ASCII character 31
    set outText to ""
    set n to 0
    tell application "Contacts"
        set matches to (every person whose name contains needle)
        repeat with p in matches
            if n ≥ maxItems then exit repeat
            set pname to name of p
            set pemail to ""
            try
                if (count of emails of p) > 0 then set pemail to value of first email of p
            end try
            set pphone to ""
            try
                if (count of phones of p) > 0 then set pphone to value of first phone of p
            end try
            set outText to outText & pname & sep & pemail & sep & pphone & linefeed
            set n to n + 1
        end repeat
    end tell
    return outText
end run
"#;
    let raw = osascript_stdout(script, &[query, &limit])?;
    let items: Vec<Value> = raw
        .lines()
        .filter(|l| l.contains('\x1f'))
        .map(|l| {
            let p: Vec<&str> = l.split('\x1f').collect();
            json!({
                "name": p.first().copied().unwrap_or(""),
                "email": p.get(1).copied().unwrap_or(""),
                "phone": p.get(2).copied().unwrap_or(""),
            })
        })
        .collect();
    Ok(json!({ "success": true, "count": items.len(), "contacts": items }))
}

#[cfg(target_os = "macos")]
fn shortcuts(req: &MacAppRequest<'_>) -> Result<Value> {
    let op = if req.op.is_empty() { "list" } else { req.op };
    match op {
        "list" => {
            let out = std::process::Command::new("shortcuts")
                .arg("list")
                .output()?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(anyhow!("shortcuts list failed: {err}"));
            }
            let names: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .take(req.limit.clamp(1, 200))
                .collect();
            Ok(json!({ "success": true, "count": names.len(), "shortcuts": names }))
        }
        "run" => {
            let name = req
                .name
                .or(req.title)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| anyhow!("name required for mac_shortcuts run"))?;
            let mut cmd = std::process::Command::new("shortcuts");
            cmd.arg("run").arg(name);
            let out = if let Some(input) = req.text {
                use std::io::Write;
                use std::process::Stdio;
                let mut child = cmd
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()?;
                if let Some(mut stdin) = child.stdin.take() {
                    stdin.write_all(input.as_bytes())?;
                }
                child.wait_with_output()?
            } else {
                cmd.output()?
            };
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(anyhow!("shortcuts run failed: {err}"));
            }
            Ok(json!({
                "success": true,
                "shortcut": name,
                "output": String::from_utf8_lossy(&out.stdout).trim().to_string(),
            }))
        }
        other => Err(anyhow!("Unknown mac_shortcuts op {other:?}; use 'list' or 'run'")),
    }
}
