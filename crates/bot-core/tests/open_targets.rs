#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command, time::Duration};

struct Fixture {
    dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(["init", "-q", "-b", "main"])
                .status()
                .unwrap()
                .success()
        );
        let peer = dir.path().join("peer.py");
        std::fs::write(&peer, include_str!("support/codex_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            config: RuntimeConfig {
                data_dir: dir.path().join("state"),
                codex_binary: peer,
                gh_binary: dir.path().join("no-gh"),
                network_timeout: Duration::from_secs(180),
                shell: None,
            },
            dir,
            repository,
        }
    }
}

fn workspace(workspace_id: &WorkspaceId, path: &str) -> OpenTarget {
    OpenTarget::Workspace {
        workspace_id: workspace_id.clone(),
        thread_id: None,
        path: path.into(),
    }
}

#[tokio::test]
async fn workspace_targets_resolve_only_inside_the_checkout() {
    let f = Fixture::new();
    let outside = f.dir.path().join("outside.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    std::fs::write(f.repository.join("README.md"), "fixture\n").unwrap();
    std::os::unix::fs::symlink(&outside, f.repository.join("escape")).unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let id = app.open_workspace(f.repository.clone()).await.unwrap().id;
    let root = f.repository.canonicalize().unwrap();

    assert_eq!(
        app.open_target_path(workspace(&id, "README.md"))
            .await
            .unwrap(),
        root.join("README.md")
    );
    assert_eq!(
        app.open_target_path(workspace(&id, "")).await.unwrap(),
        root
    );
    for refused in [
        "../outside.txt",
        "/etc/passwd",
        ".git/config",
        "escape",
        "missing.txt",
    ] {
        let error = app
            .open_target_path(workspace(&id, refused))
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_path", "{refused}: {}", error.message);
    }
    assert_eq!(
        app.open_target_path(workspace(&id, "missing.txt"))
            .await
            .unwrap_err()
            .message,
        "This file no longer exists."
    );
    assert_eq!(
        app.reveal_in_finder(workspace(&id, "../outside.txt"))
            .await
            .unwrap_err()
            .code,
        "invalid_path"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn chat_links_resolve_only_paths_the_thread_names() {
    let f = Fixture::new();
    let docs = f.dir.path().join("shared docs");
    std::fs::create_dir(&docs).unwrap();
    let named = docs.join("plan notes.md");
    let unnamed = docs.join("other.md");
    std::fs::write(&named, "plan\n").unwrap();
    std::fs::write(&unnamed, "other\n").unwrap();
    let gone = docs.join("gone.md");
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    let prompt = format!(
        "Read [the plan]({}:4) and {}",
        named.display().to_string().replace(' ', "%20"),
        gone.display()
    );
    app.submit(thread.id.clone(), "named".into(), prompt, vec![])
        .await
        .unwrap();
    let link = |path: &std::path::Path| OpenTarget::ChatLink {
        thread_id: thread.id.clone(),
        path: path.display().to_string(),
    };

    assert_eq!(
        app.open_target_path(link(&named)).await.unwrap(),
        named.canonicalize().unwrap()
    );
    for (path, message) in [
        (
            unnamed.as_path(),
            "Only files named in this conversation can be opened.",
        ),
        (
            docs.as_path(),
            "Only files named in this conversation can be opened.",
        ),
        (gone.as_path(), "This file no longer exists."),
    ] {
        let error = app.open_target_path(link(path)).await.unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("invalid_path", message),
            "{}",
            path.display()
        );
    }
    let relative = OpenTarget::ChatLink {
        thread_id: thread.id.clone(),
        path: "plan notes.md".into(),
    };
    assert_eq!(
        app.open_target_path(relative).await.unwrap_err().code,
        "invalid_path"
    );
    assert_eq!(
        app.open_in_editor(link(&unnamed), EditorId::FileManager, None)
            .await
            .unwrap_err()
            .code,
        "invalid_path"
    );
    app.shutdown().await.unwrap();
}

#[test]
fn open_target_json_matches_the_ui_contract() {
    let target: OpenTarget = serde_json::from_value(serde_json::json!({
        "kind": "workspace",
        "workspace_id": "00000000-0000-0000-0000-000000000001",
        "thread_id": null,
        "path": "src/main.rs",
    }))
    .unwrap();
    assert!(
        matches!(target, OpenTarget::Workspace { thread_id: None, ref path, .. } if path == "src/main.rs")
    );
    let target: OpenTarget = serde_json::from_value(serde_json::json!({
        "kind": "chat_link",
        "thread_id": "00000000-0000-0000-0000-000000000002",
        "path": "/tmp/a.rs",
    }))
    .unwrap();
    assert!(matches!(target, OpenTarget::ChatLink { ref path, .. } if path == "/tmp/a.rs"));
}
