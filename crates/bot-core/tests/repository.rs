#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{path::Path, process::Command};
fn git(root: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap()
            .success()
    );
}
#[test]
fn reads_real_index_worktree_untracked_and_rename_diffs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "base",
        ],
    );
    std::fs::write(root.join("a.txt"), "index\n").unwrap();
    git(root, &["add", "a.txt"]);
    std::fs::write(root.join("a.txt"), "worktree\n").unwrap();
    std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
    match repo::diff(root, "a.txt", DiffBasis::Staged).unwrap() {
        DiffView::Text {
            old_contents,
            new_contents,
            ..
        } => assert_eq!(
            (old_contents, new_contents),
            ("base\n".into(), "index\n".into())
        ),
        other => panic!("{other:?}"),
    }
    match repo::diff(root, "a.txt", DiffBasis::Unstaged).unwrap() {
        DiffView::Text {
            old_contents,
            new_contents,
            ..
        } => assert_eq!(
            (old_contents, new_contents),
            ("index\n".into(), "worktree\n".into())
        ),
        other => panic!("{other:?}"),
    }
    match repo::diff(root, "new.txt", DiffBasis::Unstaged).unwrap() {
        DiffView::Text {
            old_contents,
            new_contents,
            ..
        } => assert_eq!(
            (old_contents, new_contents),
            (String::new(), "untracked\n".into())
        ),
        other => panic!("{other:?}"),
    }
    git(root, &["reset", "--hard", "-q", "HEAD"]);
    git(root, &["mv", "a.txt", "renamed.txt"]);
    match repo::diff(root, "renamed.txt", DiffBasis::Staged).unwrap() {
        DiffView::Text {
            old_name,
            old_contents,
            new_contents,
            ..
        } => {
            assert_eq!(old_name, "a.txt");
            assert_eq!(old_contents, "base\n");
            assert_eq!(new_contents, "base\n")
        }
        other => panic!("{other:?}"),
    }
}
#[cfg(unix)]
#[test]
fn refuses_traversal_external_symlinks_binary_and_large_text() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    let canonical = repo::open(root).unwrap();
    assert!(repo::read_file(&canonical, "../outside").is_err());
    assert!(repo::read_file(&canonical, ".git/config").is_err());
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
    assert!(repo::read_file(&canonical, "escape").is_err());
    std::fs::write(root.join("binary"), [0, 1, 2]).unwrap();
    assert!(matches!(
        repo::read_file(&canonical, "binary").unwrap(),
        FileView::Unavailable { .. }
    ));
    std::fs::write(root.join("large"), vec![b'a'; 1_000_001]).unwrap();
    assert!(matches!(
        repo::read_file(&canonical, "large").unwrap(),
        FileView::Unavailable { .. }
    ));
}
#[test]
fn reads_media_by_revision_and_keeps_text_diffs_for_svg() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    let canonical = repo::open(root).unwrap();
    std::fs::write(root.join("tone.WAV"), vec![0; 2_000_000]).unwrap();
    std::fs::write(root.join("mark.svg"), "<svg/>").unwrap();
    std::fs::create_dir(root.join("assets.png")).unwrap();
    let FileView::Media { name, revision } = repo::read_file(&canonical, "tone.WAV").unwrap()
    else {
        panic!("audio over the text limit is media, not unavailable")
    };
    assert_eq!(name, "tone.WAV");
    assert!(revision.starts_with("2000000-"), "{revision}");
    let FileView::Media {
        revision: before, ..
    } = repo::read_file(&canonical, "mark.svg").unwrap()
    else {
        panic!("svg is an image")
    };
    std::fs::write(root.join("mark.svg"), "<svg></svg>").unwrap();
    let FileView::Media {
        revision: after, ..
    } = repo::read_file(&canonical, "mark.svg").unwrap()
    else {
        panic!("svg is an image")
    };
    assert_ne!(before, after, "a rewrite changes the revision");
    assert!(repo::read_file(&canonical, "assets.png").is_err());
    assert!(matches!(
        repo::diff(&canonical, "mark.svg", DiffBasis::Unstaged).unwrap(),
        DiffView::Text { new_contents, .. } if new_contents == "<svg></svg>"
    ));
}
#[test]
fn reads_refuse_git_metadata_under_another_spelling() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    let root = repo::open(dir.path()).unwrap();
    // On a case-sensitive volume `.GIT` names nothing, so there is no alias to refuse.
    if !root.join(".GIT").exists() {
        return;
    }
    let error = repo::read_file(&root, ".GIT/config").unwrap_err();
    assert_eq!(error.message, "Choose a file inside the repository.");
}
#[cfg(unix)]
fn refusal(result: Result<()>) -> (String, String) {
    let e = result.unwrap_err();
    (e.code, e.message)
}
#[cfg(unix)]
fn inside() -> (String, String) {
    (
        "invalid_path".into(),
        "Choose a file inside the repository.".into(),
    )
}
#[cfg(unix)]
fn outside() -> (String, String) {
    (
        "invalid_path".into(),
        "This symlink points outside the repository.".into(),
    )
}
#[cfg(unix)]
#[test]
fn writes_tracked_files_in_place_through_in_repo_symlinks_and_new_parents() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    std::fs::write(root.join("b.txt"), "b\n").unwrap();
    std::fs::set_permissions(root.join("a.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    git(root, &["add", "a.txt", "b.txt"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "base",
        ],
    );
    let canonical = repo::open(root).unwrap();
    repo::write_file(&canonical, "a.txt", "edited\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::metadata(root.join("a.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    let diff = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "--name-only"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(diff.stdout).unwrap(), "a.txt\n");
    std::os::unix::fs::symlink("b.txt", root.join("link")).unwrap();
    repo::write_file(&canonical, "link", "through link\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "through link\n"
    );
    assert!(root.join("link").symlink_metadata().unwrap().is_symlink());
    repo::write_file(&canonical, "new/deeper/c.txt", "c\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("new/deeper/c.txt")).unwrap(),
        "c\n"
    );
    let limit = "x".repeat(1_000_000);
    repo::write_file(&canonical, "limit.txt", &limit).unwrap();
    assert!(matches!(
        repo::read_file(&canonical, "limit.txt").unwrap(),
        FileView::Text { contents, .. } if contents == limit
    ));
}
#[cfg(unix)]
#[test]
fn write_refuses_paths_outside_the_repository_and_inside_git() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    let canonical = repo::open(root).unwrap();
    let config = std::fs::read(root.join(".git/config")).unwrap();
    for path in ["", "../x", "/abs/path", ".git/config", "./a.txt"] {
        assert_eq!(
            refusal(repo::write_file(&canonical, path, "x")),
            inside(),
            "{path}"
        );
    }
    assert!(!dir.path().parent().unwrap().join("x").exists());
    assert!(!Path::new("/abs/path").exists());
    for path in [".GIT/config", "new/.GIT/config"] {
        assert_eq!(
            refusal(repo::write_file(&canonical, path, "x")),
            inside(),
            "{path}"
        );
    }
    assert!(!root.join("new").exists());
    std::os::unix::fs::symlink(".git/config", root.join("config")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "config", "x")),
        inside()
    );
    std::os::unix::fs::symlink(".git/hooks", root.join("hooks")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "hooks/pre-commit", "x")),
        inside()
    );
    assert_eq!(std::fs::read(root.join(".git/config")).unwrap(), config);
    assert!(!root.join(".git/hooks/pre-commit").exists());
    std::fs::create_dir(root.join("folder")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "folder", "x")),
        inside()
    );
    assert!(root.join("folder").is_dir());
    for path in ["folder/./x.txt", "folder//x.txt", "folder/", "x/../y"] {
        assert_eq!(
            refusal(repo::write_file(&canonical, path, "x")),
            inside(),
            "{path}"
        );
    }
    assert!(!root.join("folder/x.txt").exists());
    assert!(!root.join("y").exists());
    std::fs::write(root.join("plain.txt"), "plain\n").unwrap();
    std::os::unix::fs::symlink("plain.txt", root.join("plainlink")).unwrap();
    for path in ["plain.txt/x", "plainlink/x", "plainlink/deeper/x"] {
        assert_eq!(
            refusal(repo::write_file(&canonical, path, "x")),
            inside(),
            "{path}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.join("plain.txt")).unwrap(),
        "plain\n"
    );
    std::fs::write(root.join("big.txt"), "small\n").unwrap();
    assert_eq!(
        refusal(repo::write_file(
            &canonical,
            "big.txt",
            &"x".repeat(1_000_001)
        )),
        (
            "file_unavailable".into(),
            "This file exceeds the 1 MB text limit.".into()
        )
    );
    assert_eq!(
        std::fs::read_to_string(root.join("big.txt")).unwrap(),
        "small\n"
    );
}
#[cfg(unix)]
#[test]
fn write_refuses_symlinks_that_escape_the_repository() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    let canonical = repo::open(root).unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let outside_file = elsewhere.path().join("outside.txt");
    std::fs::write(&outside_file, "outside\n").unwrap();
    std::os::unix::fs::symlink(&outside_file, root.join("escape-file")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "escape-file", "x")),
        outside()
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside\n");
    std::os::unix::fs::symlink(elsewhere.path(), root.join("escape")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "escape/new.txt", "x")),
        outside()
    );
    assert_eq!(
        refusal(repo::write_file(&canonical, "escape/sub/new.txt", "x")),
        outside()
    );
    assert_eq!(
        refusal(repo::write_file(&canonical, "escape/outside.txt", "x")),
        outside()
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside\n");
    assert!(!elsewhere.path().join("new.txt").exists());
    assert!(!elsewhere.path().join("sub").exists());
    let dangling = elsewhere.path().join("missing/target.txt");
    std::os::unix::fs::symlink(&dangling, root.join("dangling")).unwrap();
    assert_eq!(
        refusal(repo::write_file(&canonical, "dangling", "x")),
        inside()
    );
    assert!(!elsewhere.path().join("missing").exists());
}

#[test]
fn historical_large_blob_is_unavailable_and_absent_sides_still_work() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    std::fs::write(root.join("large.txt"), vec![b'x'; 1_000_001]).unwrap();
    git(root, &["add", "large.txt"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "large",
        ],
    );
    std::fs::write(
        root.join("large.txt"),
        "small
",
    )
    .unwrap();
    assert!(matches!(
        repo::diff(root, "large.txt", DiffBasis::Unstaged).unwrap(),
        DiffView::Unavailable { .. }
    ));
    git(root, &["add", "large.txt"]);
    assert!(matches!(
        repo::diff(root, "large.txt", DiffBasis::Staged).unwrap(),
        DiffView::Unavailable { .. }
    ));
}
