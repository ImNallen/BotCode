pub fn wait_for_file(path: &str) -> String {
    format!(
        "while [ ! -e {path} ] && kill -0 {} 2>/dev/null; do sleep 0.05; done",
        std::process::id()
    )
}
