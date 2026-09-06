fn main() {
    println!("cargo:rerun-if-changed=catalog.json");
    let source = std::path::Path::new("../src/tools/catalog.json");
    if source.exists() {
        println!("cargo:rerun-if-changed={}", source.display());
        assert_eq!(
            std::fs::read(source).expect("read cloud-generated catalog"),
            std::fs::read("catalog.json").expect("read packaged catalog"),
            "Rust catalog drift: run python3 scripts/sync-rust-catalog.py"
        );
    }
}
