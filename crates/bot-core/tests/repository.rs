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
