//! `corpus FILE.jsonl [--home DIR] [--roots A:B] [--samples FILE] [--limit N]`: classifies every
//! `{"cmd", "cwd"}` line, and reports the verdicts, what could not be read, and the time.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::Instant;

use hanzo_shell::{classify, Context, Kind, Risk};

fn main() {
    let mut path = None;
    let mut home = None;
    let mut roots: Vec<String> = Vec::new();
    let mut samples = None;
    let mut limit = usize::MAX;
    let mut find: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--home" => home = args.next(),
            "--roots" => roots = args.next().unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(String::from).collect(),
            "--samples" => samples = args.next(),
            "--limit" => limit = args.next().and_then(|v| v.parse().ok()).unwrap_or(usize::MAX),
            "--find" => find = args.next(),
            _ => path = Some(a),
        }
    }
    let path = path.expect("a corpus file");
    let file = std::fs::File::open(&path).expect("open corpus");
    let child = std::thread::Builder::new().stack_size(64 << 20).spawn(move || run(file, home, roots, samples, limit, find)).unwrap();
    child.join().unwrap();
}

fn run(file: std::fs::File, home: Option<String>, roots: Vec<String>, samples: Option<String>, limit: usize, find: Option<String>) {
    let mut found: HashMap<String, (u64, String)> = HashMap::new();
    let mut slow: Vec<(u64, String)> = Vec::new();
    let mut n = 0u64;
    let mut by_risk: HashMap<&str, u64> = HashMap::new();
    let mut unparsed = 0u64;
    let mut unparsed_shell = 0u64;
    let mut kinds: HashMap<String, u64> = HashMap::new();
    let mut reasons: HashMap<String, (u64, Vec<String>)> = HashMap::new();
    let mut times: Vec<u64> = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        if n as usize >= limit {
            break;
        }
        let line = line.unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let (cmd, cwd) = match &v {
            serde_json::Value::String(s) => (s.clone(), None),
            o => (o["cmd"].as_str().unwrap_or("").to_string(), o["cwd"].as_str().map(String::from)),
        };
        let mut ctx = Context::new(cwd.as_deref(), home.as_deref());
        ctx.roots = roots.clone();
        let t = Instant::now();
        let r = classify(&cmd, &ctx);
        let us = t.elapsed().as_micros() as u64;
        times.push(us);
        if us > 3000 {
            slow.push((us, cmd.chars().take(200).collect::<String>().replace('\n', "\\n")));
        }
        if let Some(k) = &find {
            for f in &r.findings {
                if format!("{:?}", f.kind).eq_ignore_ascii_case(k) || f.reason.contains(k.as_str()) {
                    let key: String = f.reason.chars().take(90).collect();
                    let e = found.entry(format!("{:?} {}", f.risk, key)).or_insert((0, cmd.chars().take(300).collect::<String>().replace('\n', "\\n")));
                    e.0 += 1;
                }
            }
        }
        n += 1;
        *by_risk.entry(match r.risk { Risk::Allow => "allow", Risk::Ask => "ask", Risk::Deny => "deny" }).or_default() += 1;
        if r.findings.iter().any(|f| f.kind == Kind::Unparsed) {
            unparsed += 1;
        }
        if r.findings.iter().any(|f| f.reason.contains("does not parse as shell")) {
            unparsed_shell += 1;
        }
        let mut seen = std::collections::HashSet::new();
        for f in &r.findings {
            if f.risk == r.risk && seen.insert(f.kind) {
                *kinds.entry(format!("{:?}/{:?}", r.risk, f.kind)).or_default() += 1;
            }
        }
        if let Some(f) = r.findings.first() {
            let key: String = f.reason.chars().filter(|c| !c.is_ascii_digit()).collect::<String>();
            let key: String = key.split(':').next().unwrap_or("").chars().take(70).collect();
            let key = format!("{:?} {:?} {}", f.risk, f.kind, if f.reason.starts_with("unknown command") || f.reason.starts_with("cannot read") { f.reason.clone() } else { key });
            let e = reasons.entry(key).or_default();
            e.0 += 1;
            if e.1.len() < 4 {
                e.1.push(cmd.chars().take(240).collect::<String>().replace('\n', "\\n"));
            }
        }
    }
    times.sort();
    let pct = |c: u64| 100.0 * c as f64 / n.max(1) as f64;
    println!("commands {n}");
    for k in ["allow", "ask", "deny"] {
        let c = by_risk.get(k).copied().unwrap_or(0);
        println!("  {k:6} {c:8} {:6.2}%", pct(c));
    }
    println!("unparsed (any kind) {unparsed} {:.3}%   shell syntax unparsed {unparsed_shell} {:.3}%", pct(unparsed), pct(unparsed_shell));
    if !times.is_empty() {
        let q = |p: f64| times[((times.len() - 1) as f64 * p) as usize];
        println!("time us: p50 {} p90 {} p99 {} p99.9 {} max {} mean {}", q(0.5), q(0.9), q(0.99), q(0.999), times[times.len() - 1], times.iter().sum::<u64>() / times.len() as u64);
    }
    let mut kv: Vec<_> = kinds.into_iter().collect();
    kv.sort_by(|a, b| b.1.cmp(&a.1));
    println!("kinds:");
    for (k, c) in kv.iter().take(30) {
        println!("  {c:8} {k}");
    }
    let mut rv: Vec<_> = reasons.into_iter().collect();
    rv.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    println!("first reasons:");
    for (k, (c, ex)) in rv.iter().take(70) {
        println!("  {c:8} {k}");
        if let Some(e) = ex.first() {
            println!("           e.g. {e}");
        }
    }
    if find.is_some() {
        let mut fv: Vec<_> = found.into_iter().collect();
        fv.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        println!("found:");
        for (k, (c, ex)) in fv.iter().take(60) {
            println!("  {c:7} {k}\n          e.g. {ex}");
        }
    }
    slow.sort_by(|a, b| b.0.cmp(&a.0));
    println!("slowest:");
    for (us, c) in slow.iter().take(12) {
        println!("  {us:8}us {c}");
    }
    if let Some(p) = samples {
        let mut f = std::fs::File::create(p).unwrap();
        for (k, (c, ex)) in &rv {
            let _ = writeln!(f, "{}", serde_json::json!({"reason": k, "count": c, "examples": ex}));
        }
    }
}
