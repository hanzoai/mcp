//! `classify [--cwd DIR] [--home DIR] [--root DIR]... COMMAND`: prints the report as JSON.

use hanzo_shell::{classify, Context};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut ctx = Context::new(None, None);
    let mut command = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--cwd" => ctx.cwd = args.next(),
            "--home" => ctx.home = args.next(),
            "--root" => ctx.roots.extend(args.next()),
            "--remote" => ctx.remote = true,
            _ => command = Some(a),
        }
    }
    let Some(command) = command else {
        eprintln!("usage: classify [--cwd DIR] [--home DIR] [--root DIR] COMMAND");
        std::process::exit(2);
    };
    println!("{}", serde_json::to_string_pretty(&classify(&command, &ctx)).unwrap_or_default());
}
