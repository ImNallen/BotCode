fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/mac_permission_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("bot_permissions");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rerun-if-changed=src/mac_permission_helper.m");
    }
    tauri_build::build()
}
