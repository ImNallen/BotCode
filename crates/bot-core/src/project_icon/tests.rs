use super::*;
use crate::{App, RuntimeConfig, Workspace, WorkspaceId};

fn write(root: &Path, name: &str, text: impl AsRef<[u8]>) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}
fn resolved(resolver: &FaviconResolver, root: &Path, saved: Option<&str>) -> ProjectFavicon {
    resolver.resolve(root, saved).unwrap().unwrap()
}
fn assert_image(image: ProjectFavicon, path: &Path, content: &str) {
    assert_eq!(
        dunce::canonicalize(&image.path).unwrap(),
        dunce::canonicalize(path).unwrap()
    );
    assert_eq!(
        STANDARD
            .decode(image.data_url.split(',').nth(1).unwrap())
            .unwrap(),
        content.as_bytes()
    );
}
#[test]
fn favicon_discovery_follows_saved_config_and_candidate_precedence() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let automatic = write(root.path(), "favicon.svg", "<svg>automatic</svg>");
    write(root.path(), "public/favicon.svg", "<svg>public</svg>");
    let configured = write(root.path(), "brand.svg", "<svg>configured</svg>");
    write(root.path(), "t3.json", r#"{"iconPath":"brand.svg"}"#);
    let selected = write(outside.path(), "selected.svg", "<svg>selected</svg>");
    let resolver = FaviconResolver::default();
    assert_image(
        resolved(&resolver, root.path(), selected.to_str()),
        &selected,
        "<svg>selected</svg>",
    );
    assert_image(
        resolved(&resolver, root.path(), None),
        &configured,
        "<svg>configured</svg>",
    );
    fs::remove_file(&configured).unwrap();
    assert_image(
        resolved(&resolver, root.path(), None),
        &automatic,
        "<svg>automatic</svg>",
    );
    fs::remove_file(&selected).unwrap();
    assert_image(
        resolved(&resolver, root.path(), selected.to_str()),
        &automatic,
        "<svg>automatic</svg>",
    );
}
#[test]
fn cached_favicon_refreshes_contents_and_deleted_candidates_immediately() {
    let root = tempfile::tempdir().unwrap();
    let first = write(root.path(), "favicon.svg", "<svg>first</svg>");
    let second = write(root.path(), "public/favicon.svg", "<svg>second</svg>");
    let resolver = FaviconResolver::default();
    assert_image(
        resolved(&resolver, root.path(), None),
        &first,
        "<svg>first</svg>",
    );
    fs::write(&first, "<svg>changed</svg>").unwrap();
    assert_image(
        resolved(&resolver, root.path(), None),
        &first,
        "<svg>changed</svg>",
    );
    fs::remove_file(first).unwrap();
    assert_image(
        resolved(&resolver, root.path(), None),
        &second,
        "<svg>second</svg>",
    );
}
#[test]
fn metadata_supports_either_attribute_order_object_runs_and_query_suffixes() {
    for source in [
        r#"<link rel="shortcut icon" href="/icons/Brand.svg?cache=1">"#,
        r#"<LINK HREF='/icons/Brand.svg?cache=2' REL='icon'>"#,
        r#"[{ rel: 'icon' }, { href: '/icons/Brand.svg?cache=3', rel: 'icon' }]"#,
    ] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "index.html", source);
        let image = write(root.path(), "public/icons/Brand.svg", "<svg>public</svg>");
        write(root.path(), "icons/Brand.svg", "<svg>root</svg>");
        assert_image(
            resolved(&FaviconResolver::default(), root.path(), None),
            &image,
            "<svg>public</svg>",
        );
    }
    assert_eq!(
        icon_href("<linked rel='icon' href='bad.svg'><link rel='icon' href='good.svg'>"),
        Some("good.svg")
    );
}
#[test]
fn confined_discovery_refuses_escape_paths_and_symlinks_including_cache_hits() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("project");
    fs::create_dir(&root).unwrap();
    write(parent.path(), "escape.svg", "<svg>outside</svg>");
    write(&root, "t3.json", r#"{"iconPath":"../escape.svg"}"#);
    write(
        &root,
        "index.html",
        "<link rel='icon' href='../../escape.svg'>",
    );
    assert!(
        FaviconResolver::default()
            .resolve(&root, None)
            .unwrap()
            .is_none()
    );
    #[cfg(unix)]
    {
        let outside = parent.path().join("escape.svg");
        let first = write(&root, "favicon.svg", "<svg>inside</svg>");
        let fallback = write(&root, "public/favicon.svg", "<svg>fallback</svg>");
        let resolver = FaviconResolver::default();
        assert_image(
            resolved(&resolver, &root, None),
            &first,
            "<svg>inside</svg>",
        );
        fs::remove_file(&first).unwrap();
        std::os::unix::fs::symlink(&outside, &first).unwrap();
        assert_image(
            resolved(&resolver, &root, None),
            &fallback,
            "<svg>fallback</svg>",
        );
        assert_image(
            resolved(&resolver, &root, outside.to_str()),
            &outside,
            "<svg>outside</svg>",
        );
    }
}
#[test]
fn favicon_read_errors_are_not_hidden_as_missing_images() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "index.html", [0xff]);
    assert!(
        FaviconResolver::default()
            .resolve(root.path(), None)
            .is_err()
    );
    assert!(normalize_favicon_path("icon.txt".into()).is_err());
    assert_eq!(
        normalize_favicon_path(" Image.SVG ".into()).unwrap(),
        "Image.SVG"
    );
    assert!(normalize_favicon_path(format!("{}.svg", "a".repeat(1024))).is_err());
}
#[test]
fn malformed_project_config_keeps_automatic_favicon_discovery() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "t3.json", "{broken}");
    let path = write(root.path(), "favicon.svg", "<svg>automatic</svg>");
    assert_image(
        resolved(&FaviconResolver::default(), root.path(), None),
        &path,
        "<svg>automatic</svg>",
    );
    fs::remove_file(path).unwrap();
    write(
        root.path(),
        "index.html",
        "<link rel='icon' href='brand.svg'>",
    );
    let path = write(root.path(), "public/brand.svg", "<svg>metadata</svg>");
    assert_image(
        resolved(&FaviconResolver::default(), root.path(), None),
        &path,
        "<svg>metadata</svg>",
    );
}
#[test]
fn icon_boundary_normalizes_unicode_and_rejects_invalid_values() {
    let color = ProjectIconColor::Violet;
    for (text, expected) in [
        (" ｔ３ ", "T3"),
        ("a\u{301}", "Á"),
        ("क्\u{200d}ष", "क्\u{200d}ष"),
        ("ß", "SS"),
    ] {
        assert_eq!(
            ProjectIconOverride::Monogram {
                text: text.into(),
                color
            }
            .normalize()
            .unwrap(),
            ProjectIconOverride::Monogram {
                text: expected.into(),
                color
            }
        );
    }
    for text in ["ABC", "!", "\u{301}a", "a💻", "", "ßa"] {
        assert!(
            ProjectIconOverride::Monogram {
                text: text.into(),
                color
            }
            .normalize()
            .is_err(),
            "{text}"
        );
    }
    for name in ["folder-code", "flame", "1"] {
        assert!(
            ProjectIconOverride::Lucide {
                name: name.into(),
                color
            }
            .normalize()
            .is_ok()
        );
    }
    for name in ["Folder", "a--b", "-a", "a_", ""] {
        assert!(
            ProjectIconOverride::Lucide {
                name: name.into(),
                color
            }
            .normalize()
            .is_err()
        );
    }
    assert!(
        ProjectIconOverride::Emoji {
            emoji: "🧑‍🚀".into()
        }
        .normalize()
        .is_ok()
    );
    assert!(
        ProjectIconOverride::Emoji {
            emoji: "🚀".repeat(17)
        }
        .normalize()
        .is_err()
    );
}
async fn open(state: &Path) -> App {
    App::open(RuntimeConfig {
        data_dir: state.into(),
        codex_binary: "/usr/bin/false".into(),
        gh_binary: "/usr/bin/false".into(),
        network_timeout: Duration::from_secs(1),
        shell: None,
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn saved_icons_files_and_reset_persist_across_runtime_restart() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        crate::process::command("git")
            .args(["init", "-q"])
            .arg(root.path())
            .status()
            .unwrap()
            .success()
    );
    let state = tempfile::tempdir().unwrap();
    let automatic = write(root.path(), "favicon.svg", "<svg>auto</svg>");
    let chosen = write(root.path(), "chosen.svg", "<svg>chosen</svg>");
    let app = open(state.path()).await;
    let workspace = app.open_workspace(root.path().into()).await.unwrap();
    let id = workspace.id;
    let icon = ProjectIconOverride::Monogram {
        text: "bc".into(),
        color: ProjectIconColor::Rose,
    };
    let saved = app
        .update_project_icon(id.clone(), Some(icon), None)
        .await
        .unwrap();
    assert_eq!(
        saved.project_icon,
        Some(ProjectIconOverride::Monogram {
            text: "BC".into(),
            color: ProjectIconColor::Rose
        })
    );
    assert!(saved.favicon_path.is_none());
    assert!(app.project_favicon(id.clone()).await.unwrap().is_none());
    app.shutdown().await.unwrap();
    drop(app);
    let app = open(state.path()).await;
    assert_eq!(
        app.list_workspaces().await.unwrap()[0].project_icon,
        saved.project_icon
    );
    let saved = app
        .update_project_icon(id.clone(), None, chosen.to_str().map(str::to_owned))
        .await
        .unwrap();
    assert!(saved.project_icon.is_none());
    assert_image(
        app.project_favicon(id.clone()).await.unwrap().unwrap(),
        &chosen,
        "<svg>chosen</svg>",
    );
    app.shutdown().await.unwrap();
    drop(app);
    let app = open(state.path()).await;
    assert_eq!(
        app.list_workspaces().await.unwrap()[0].favicon_path,
        saved.favicon_path
    );
    app.update_project_icon(id.clone(), None, None)
        .await
        .unwrap();
    assert_image(
        app.project_favicon(id.clone()).await.unwrap().unwrap(),
        &automatic,
        "<svg>auto</svg>",
    );
    assert!(
        app.update_project_icon(
            id.clone(),
            Some(ProjectIconOverride::Emoji {
                emoji: "💻".into()
            }),
            Some("chosen.svg".into())
        )
        .await
        .is_err()
    );
    let saved = app.list_workspaces().await.unwrap();
    assert!(saved[0].project_icon.is_none() && saved[0].favicon_path.is_none());
    let scratch = app.ensure_scratch().await.unwrap();
    assert!(
        app.update_project_icon(
            scratch.id,
            Some(ProjectIconOverride::Emoji {
                emoji: "💻".into()
            }),
            None
        )
        .await
        .is_err()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn legacy_workspace_records_load_without_icon_metadata() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let id = WorkspaceId::default();
    let json = serde_json::json!({"id": id, "root": root.path(), "label": "Legacy"});
    let workspace: Workspace = serde_json::from_value(json.clone()).unwrap();
    assert!(workspace.favicon_path.is_none() && workspace.project_icon.is_none());
    let store = crate::store::Store::open(state.path()).unwrap();
    store.workspace(&workspace).unwrap();
    store.close().unwrap();
    let db = rusqlite::Connection::open(state.path().join("z1.sqlite")).unwrap();
    db.execute("UPDATE workspaces SET data=?1", [json.to_string()])
        .unwrap();
    drop(db);
    let app = open(state.path()).await;
    let workspaces = app.list_workspaces().await.unwrap();
    assert_eq!(workspaces[0].label, "Legacy");
    assert!(workspaces[0].favicon_path.is_none() && workspaces[0].project_icon.is_none());
    app.shutdown().await.unwrap();
}
