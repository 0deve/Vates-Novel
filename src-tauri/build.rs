fn main() {
    // Private scraper sources live in the gitignored /private directory
    // (implementation.md §2). Compile them in only when present, so public
    // clones build out of the box with StubSource.
    println!("cargo:rustc-check-cfg=cfg(has_source1)");
    println!("cargo:rerun-if-changed=../private/source1/mod.rs");
    if std::path::Path::new("../private/source1/mod.rs").exists() {
        println!("cargo:rustc-cfg=has_source1");
    }

    tauri_build::build()
}
