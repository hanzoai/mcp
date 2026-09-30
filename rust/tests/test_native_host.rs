//! The native messaging host: a browser that speaks `{"z": base64}` messages
//! on stdio reaches the router through it, both ways; and `install` registers
//! it once, leaving a manifest whose program exists alone.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use base64::Engine as _;
use hanzo_mcp::{native, zap};
use serde_json::{json, Value};
use zapd::frame::{self, Frame};

mod common;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// One native message out: u32 native-endian length, then `{"z": envelope}`.
fn send(s: &mut UnixStream, f: &Frame) {
    let msg = json!({ "z": B64.encode(f.encode()) }).to_string();
    s.write_all(&(msg.len() as u32).to_ne_bytes()).unwrap();
    s.write_all(msg.as_bytes()).unwrap();
}

/// One native message in, as the envelope it carries.
fn recv(s: &mut UnixStream) -> Frame {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).unwrap();
    let mut msg = vec![0u8; u32::from_ne_bytes(len) as usize];
    s.read_exact(&mut msg).unwrap();
    let z: Value = serde_json::from_slice(&msg).unwrap();
    Frame::decode(&B64.decode(z["z"].as_str().unwrap()).unwrap()).unwrap()
}

#[tokio::test]
async fn a_browser_on_the_native_host_answers_a_route() {
    common::home();
    let (mut browser, host) = UnixStream::pair().unwrap();
    let host_in = host.try_clone().unwrap();
    std::thread::spawn(move || native::relay(host_in, host));

    let desc = frame::Descriptor { role: frame::ROLE_PROVIDER, brand: "hanzo".into(), caps: vec![], attrs: vec![] };
    send(&mut browser, &Frame::new(frame::HELLO, "browser/native-1", "", frame::encode_hello(&desc)));
    // Presence can arrive before WELCOME: another node registering between
    // ours entering the registry and our WELCOME being queued.
    let welcome = std::iter::repeat_with(|| recv(&mut browser)).find(|f| f.typ != frame::PEER_CONNECTED).unwrap();
    assert_eq!(welcome.typ, frame::WELCOME);
    let id = welcome.to.clone();
    assert!(id.starts_with("browser/") && id.ends_with("/native-1"), "{id}");

    // The browser side: answer the first ROUTE with the method it carried.
    let answered = std::thread::spawn(move || loop {
        let f = recv(&mut browser);
        if f.typ == frame::ROUTE {
            let method = frame::Cursor::new(&f.payload).str().unwrap();
            send(&mut browser, &Frame::new(frame::RESPONSE, "", &f.from, format!("answered {method}").into_bytes()));
            return method;
        }
    });
    let reply = zap::route(&id, "hanzo.title", &[], Duration::from_secs(5)).await.unwrap();
    assert_eq!(reply, "answered hanzo.title");
    assert_eq!(answered.join().unwrap(), "hanzo.title");
}

#[cfg(target_os = "linux")]
#[test]
fn install_registers_once_and_leaves_a_working_host_alone() {
    let home = common::home().join("home");
    std::fs::create_dir_all(home.join(".config/google-chrome")).unwrap();
    let taken = home.join(".config/chromium/NativeMessagingHosts");
    std::fs::create_dir_all(&taken).unwrap();
    let theirs = json!({ "name": native::NAME, "path": "/bin/sh", "type": "stdio" }).to_string();
    std::fs::write(taken.join("ai.hanzo.zap.json"), &theirs).unwrap();

    let written = native::install().unwrap();
    let ours = home.join(".config/google-chrome/NativeMessagingHosts/ai.hanzo.zap.json");
    assert_eq!(written, vec![ours.clone()]);
    let m: Value = serde_json::from_str(&std::fs::read_to_string(&ours).unwrap()).unwrap();
    assert_eq!(m["allowed_origins"], json!(["chrome-extension://biingenefmanpecedoafkfajbnlgdmbl/"]));
    let exe = std::path::PathBuf::from(m["path"].as_str().unwrap());
    assert_eq!(exe.file_name().unwrap(), native::BIN);
    assert_eq!(std::fs::read_link(&exe).unwrap(), std::env::current_exe().unwrap());

    assert!(native::install().unwrap().is_empty(), "a second start writes nothing");
    assert_eq!(std::fs::read_to_string(taken.join("ai.hanzo.zap.json")).unwrap(), theirs);
}
