fn main() {
    println!("cargo:rerun-if-changed=../private");
    for i in 1..=8 {
        println!("cargo:rustc-check-cfg=cfg(has_source{i})");
        let path = format!("../private/source{i}/mod.rs");
        if std::path::Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
            println!("cargo:rustc-cfg=has_source{i}");
        }
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    tauri_build::build()
}
