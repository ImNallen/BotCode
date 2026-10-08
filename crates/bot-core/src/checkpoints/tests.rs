use super::*;
fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]).unwrap();
    git(dir.path(), &["config", "user.name", "Test"]).unwrap();
    git(
        dir.path(),
        &["config", "user.email", "test@example.invalid"],
    )
    .unwrap();
    dir
}
fn write(root: &Path, name: &str, contents: impl AsRef<[u8]>) {
    if let Some(parent) = root.join(name).parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(root.join(name), contents).unwrap();
}
fn commit(root: &Path) {
    git(root, &["add", "-A"]).unwrap();
    git(root, &["commit", "-qm", "base"]).unwrap();
}
fn capture_at(root: &Path, name: &str) -> Checkpoint {
    capture(root, &format!("{PREFIX}test/{name}")).unwrap()
}
fn contents(root: &Path, checkpoint: &Checkpoint, name: &str) -> Option<String> {
    blob(root, &checkpoint.commit, name)
        .unwrap()
        .map(|file| file.contents)
}
fn index_bytes(root: &Path) -> Vec<u8> {
    let index = PathBuf::from(
        utf8(
            git(
                root,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .unwrap(),
        )
        .unwrap()
        .trim(),
    );
    std::fs::read(index).unwrap()
}
#[test]
fn capture_keeps_the_real_index_head_flags_and_ignored_tracked_files() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    write(root, ".gitignore", "secret\nadded\n");
    commit(root);
    write(root, "a.txt", "index\n");
    git(root, &["add", "a.txt"]).unwrap();
    write(root, "a.txt", "after\n");
    write(root, "added", "tracked ignored\n");
    git(root, &["add", "-f", "added"]).unwrap();
    write(root, "secret", "private\n");
    write(root, "new.txt", "new\n");
    git(root, &["update-index", "--assume-unchanged", "a.txt"]).unwrap();
    git(root, &["update-index", "--skip-worktree", "added"]).unwrap();
    let index = index_bytes(root);
    let head = git(root, &["rev-parse", "HEAD"]).unwrap();
    let branch = git(root, &["symbolic-ref", "HEAD"]).unwrap();
    let flags = git(root, &["ls-files", "-v", "-z"]).unwrap();
    let snapshot = capture_at(root, "before");
    assert_eq!(contents(root, &snapshot, "a.txt"), Some("after\n".into()));
    assert_eq!(
        contents(root, &snapshot, "added"),
        Some("tracked ignored\n".into())
    );
    assert_eq!(contents(root, &snapshot, "new.txt"), Some("new\n".into()));
    assert_eq!(contents(root, &snapshot, "secret"), None);
    assert_eq!(index_bytes(root), index);
    assert_eq!(git(root, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(git(root, &["symbolic-ref", "HEAD"]).unwrap(), branch);
    assert_eq!(git(root, &["ls-files", "-v", "-z"]).unwrap(), flags);
    assert!(
        !utf8(git(root, &["cat-file", "-p", &snapshot.commit]).unwrap())
            .unwrap()
            .lines()
            .any(|line| line.starts_with("parent "))
    );
}
#[test]
fn captures_same_size_edits_with_the_original_timestamp_and_split_index() {
    let dir = repository();
    let root = dir.path();
    git(root, &["config", "core.trustctime", "false"]).unwrap();
    write(root, "a.txt", "aaaa\n");
    let stamp = std::time::SystemTime::UNIX_EPOCH;
    std::fs::File::options()
        .write(true)
        .open(root.join("a.txt"))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(stamp))
        .unwrap();
    commit(root);
    git(root, &["update-index", "--split-index"]).unwrap();
    let index = index_bytes(root);
    write(root, "a.txt", "bbbb\n");
    std::fs::File::options()
        .write(true)
        .open(root.join("a.txt"))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(stamp))
        .unwrap();
    let snapshot = capture_at(root, "split");
    assert_eq!(contents(root, &snapshot, "a.txt"), Some("bbbb\n".into()));
    assert_eq!(index_bytes(root), index);
}
#[test]
fn turn_two_diff_is_immutable_and_restore_returns_to_its_before_snapshot() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "zero\n");
    write(root, "b.txt", "zero\n");
    write(root, ".gitignore", "ignored\n");
    commit(root);
    let head = git(root, &["rev-parse", "HEAD"]).unwrap();
    write(root, "a.txt", "one\n");
    let before = capture_at(root, "turn2-before");
    write(root, "b.txt", "two\n");
    write(root, "turn2.txt", "created\n");
    let after = capture_at(root, "turn2-after");
    write(root, "a.txt", "three\n");
    write(root, "b.txt", "three\n");
    std::fs::remove_file(root.join("turn2.txt")).unwrap();
    write(root, "later.txt", "later\n");
    write(root, "ignored", "keep\n");
    let changes = files(root, &before, &after).unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["b.txt", "turn2.txt"]
    );
    assert_eq!(
        (changes[0].additions, changes[0].deletions),
        (Some(1), Some(1))
    );
    match view(root, &before, &after, "b.txt").unwrap() {
        TurnDiffView::Text { old, new } => {
            assert_eq!(old.unwrap().contents, "zero\n");
            assert_eq!(new.unwrap().contents, "two\n");
        }
        other => panic!("{other:?}"),
    }
    match view(root, &before, &after, "turn2.txt").unwrap() {
        TurnDiffView::Text { old, new } => {
            assert!(old.is_none());
            assert_eq!(new.unwrap().contents, "created\n");
        }
        other => panic!("{other:?}"),
    }
    restore(root, &before).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "zero\n"
    );
    assert!(!root.join("turn2.txt").exists());
    assert!(!root.join("later.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("ignored")).unwrap(),
        "keep\n"
    );
    assert!(
        git(root, &["diff", "--cached", "--name-only"])
            .unwrap()
            .is_empty()
    );
    assert_eq!(git(root, &["rev-parse", "HEAD"]).unwrap(), head);
    let status = git(root, &["status", "--porcelain=v1", "-z"]).unwrap();
    restore(root, &before).unwrap();
    assert_eq!(
        git(root, &["status", "--porcelain=v1", "-z"]).unwrap(),
        status
    );
}
#[test]
fn immutable_references_adopt_retry_and_create_atomically_across_worktrees() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    commit(root);
    let sibling = tempfile::tempdir().unwrap();
    let checkout = sibling.path().join("checkout");
    git(
        root,
        &[
            "worktree",
            "add",
            "-qb",
            "other",
            checkout.to_str().unwrap(),
        ],
    )
    .unwrap();
    write(root, "a.txt", "main\n");
    write(&checkout, "a.txt", "worktree\n");
    let reference = format!("{PREFIX}test/race");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers = [root.to_path_buf(), checkout.clone()].map(|root| {
        let reference = reference.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            capture(&root, &reference).unwrap()
        })
    });
    let [first, second] = workers.map(|worker| worker.join().unwrap());
    assert_eq!(first.commit, second.commit);
    write(root, "a.txt", "later\n");
    assert_eq!(capture(root, &reference).unwrap().commit, first.commit);
    git(root, &["update-ref", "-d", &reference]).unwrap();
    git(root, &["update-ref", "-d", &reference]).unwrap();
    assert!(view(root, &first, &second, "a.txt").is_err());
}
#[test]
fn worktree_restore_never_changes_its_sibling_or_branch_and_cleans_private_indexes() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    commit(root);
    let sibling = tempfile::tempdir().unwrap();
    let checkout = sibling.path().join("checkout");
    git(
        root,
        &[
            "worktree",
            "add",
            "-qb",
            "other",
            checkout.to_str().unwrap(),
        ],
    )
    .unwrap();
    write(root, "a.txt", "local\n");
    write(&checkout, "a.txt", "before\n");
    let before = capture_at(&checkout, "worktree-before");
    write(&checkout, "a.txt", "after\n");
    restore(&checkout, &before).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "local\n"
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("a.txt")).unwrap(),
        "before\n"
    );
    assert_eq!(
        git(&checkout, &["branch", "--show-current"]).unwrap(),
        b"other\n"
    );
    assert_eq!(
        resolve(root, &before.reference).unwrap(),
        Some(before.commit)
    );
    let index = PathBuf::from(
        utf8(
            git(
                &checkout,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )
            .unwrap(),
        )
        .unwrap()
        .trim(),
    );
    assert!(
        !std::fs::read_dir(index.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("bot-checkpoint-index-"))
    );
}
#[test]
fn unborn_and_empty_snapshots_restore_without_creating_head() {
    let dir = repository();
    let root = dir.path();
    let empty = capture_at(root, "empty");
    write(root, "new.txt", "before\n");
    let before = capture_at(root, "unborn");
    write(root, "new.txt", "after\n");
    write(root, "later.txt", "later\n");
    restore(root, &before).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("new.txt")).unwrap(),
        "before\n"
    );
    assert_eq!(git(root, &["ls-files"]).unwrap(), b"new.txt\n");
    assert!(resolve(root, "HEAD").unwrap().is_none());
    restore(root, &before).unwrap();
    restore(root, &empty).unwrap();
    assert!(!root.join("new.txt").exists());
    assert!(git(root, &["ls-files"]).unwrap().is_empty());
}
#[test]
fn binary_large_special_paths_and_deleted_sides_have_honest_views() {
    let dir = repository();
    let root = dir.path();
    write(root, "gone.txt", "gone\n");
    commit(root);
    let before = capture_at(root, "views-before");
    std::fs::remove_file(root.join("gone.txt")).unwrap();
    write(root, "binary", [0, 1, 2]);
    write(root, "large", vec![b'x'; 1_000_001]);
    write(root, "tab\tnewline\n.txt", "added\n");
    let after = capture_at(root, "views-after");
    assert!(matches!(
        view(root, &before, &after, "binary").unwrap(),
        TurnDiffView::Unavailable { .. }
    ));
    assert!(matches!(
        view(root, &before, &after, "large").unwrap(),
        TurnDiffView::Unavailable { .. }
    ));
    let changes = files(root, &before, &after).unwrap();
    assert!(
        changes
            .iter()
            .any(|file| file.path == "tab\tnewline\n.txt" && file.additions == Some(1))
    );
    assert!(
        changes.iter().any(|file| file.path == "binary"
            && file.additions.is_none()
            && file.deletions.is_none())
    );
    match view(root, &before, &after, "gone.txt").unwrap() {
        TurnDiffView::Text { old, new } => {
            assert_eq!(old.unwrap().contents, "gone\n");
            assert!(new.is_none());
        }
        other => panic!("{other:?}"),
    }
    for path in ["../outside", ".git/config", "/tmp/file", "", ".GIT/config"] {
        assert_eq!(
            view(root, &before, &after, path).unwrap_err().code,
            "invalid_path"
        );
    }
    assert!(capture(root, "refs/heads/should-not-move").is_err());
}
#[test]
fn ignored_path_collisions_refuse_before_any_file_or_index_mutation() {
    let dir = repository();
    let root = dir.path();
    write(root, ".gitignore", "private\n");
    write(root, "private", "saved\n");
    git(root, &["add", "-f", "private"]).unwrap();
    commit(root);
    let before = capture_at(root, "protected");
    git(root, &["rm", "--cached", "private"]).unwrap();
    write(root, "private", "secret\n");
    let index = index_bytes(root);
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_ignored_collision"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("private")).unwrap(),
        "secret\n"
    );
    assert_eq!(index_bytes(root), index);
    std::fs::remove_file(root.join("private")).unwrap();
    write(root, "private/secret", "secret\n");
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_ignored_collision"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("private/secret")).unwrap(),
        "secret\n"
    );
}
#[test]
fn changed_ignore_rules_cannot_make_clean_delete_previously_ignored_files() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    write(root, "nested/.gitignore", "nothing\n");
    commit(root);
    let before = capture_at(root, "ignore-rules");
    write(root, "a.txt", "later\n");
    write(root, "nested/.gitignore", "secret\n");
    write(root, "nested/secret", "private\n");
    let index = index_bytes(root);
    assert_eq!(
        preflight_restore(root, &before).unwrap_err().code,
        "checkpoint_ignore_rules"
    );
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_ignore_rules"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "later\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("nested/secret")).unwrap(),
        "private\n"
    );
    assert_eq!(index_bytes(root), index);
}
#[test]
fn nested_repositories_and_gitlinks_refuse_restore_and_keep_their_contents() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    commit(root);
    let before = capture_at(root, "before-nested");
    let nested = root.join("ordinary/nested");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q"]).unwrap();
    write(&nested, "secret", "keep\n");
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_restore_unavailable"
    );
    assert_eq!(
        std::fs::read_to_string(nested.join("secret")).unwrap(),
        "keep\n"
    );
    git(
        &nested,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "add",
            ".",
        ],
    )
    .unwrap();
    git(
        &nested,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "nested",
        ],
    )
    .unwrap();
    let with_nested = capture_at(root, "nested-gitlink");
    write(&nested, "secret", "dirty\n");
    assert_eq!(
        restore(root, &with_nested).unwrap_err().code,
        "checkpoint_restore_unavailable"
    );
    assert_eq!(
        std::fs::read_to_string(nested.join("secret")).unwrap(),
        "dirty\n"
    );
}
#[test]
fn missing_and_mismatched_references_refuse_restore_without_mutation() {
    let dir = repository();
    let root = dir.path();
    write(root, "a.txt", "base\n");
    commit(root);
    let before = capture_at(root, "known");
    write(root, "a.txt", "after\n");
    let mut mismatch = before.clone();
    mismatch.commit = "0".repeat(40);
    assert_eq!(
        restore(root, &mismatch).unwrap_err().code,
        "checkpoint_unavailable"
    );
    git(root, &["update-ref", "-d", &before.reference]).unwrap();
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_unavailable"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "after\n"
    );
}
#[test]
fn ignored_nested_repository_is_refused_before_restoring_any_parent_file() {
    let dir = repository();
    let root = dir.path();
    write(root, ".gitignore", "nested/\n");
    write(root, "nested/a", "snapshot\n");
    write(root, "other", "base\n");
    git(root, &["add", "-f", "nested/a"]).unwrap();
    commit(root);
    let before = capture_at(root, "ignored-nested");
    git(root, &["rm", "--cached", "nested/a"]).unwrap();
    git(&root.join("nested"), &["init", "-q"]).unwrap();
    write(root, "nested/a", "private\n");
    write(root, "other", "later\n");
    let index = index_bytes(root);
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_restore_unavailable"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("nested/a")).unwrap(),
        "private\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("other")).unwrap(),
        "later\n"
    );
    assert_eq!(index_bytes(root), index);
}
#[test]
fn reset_to_head_retries_already_restored_ignored_additions_without_overwriting_private_data() {
    let dir = repository();
    let root = dir.path();
    write(root, ".gitignore", "added/\n");
    write(root, ".gitattributes", "added/file text eol=crlf\n");
    write(root, "base", "base\n");
    commit(root);
    write(root, "added/file", "snapshot\n");
    git(root, &["add", "-f", "added/file"]).unwrap();
    let before = capture_at(root, "ignored-addition");
    write(root, "added/file", "later\n");
    restore(root, &before).unwrap();
    assert!(
        !git(root, &["ls-files"])
            .unwrap()
            .windows(b"added/file".len())
            .any(|part| part == b"added/file")
    );
    write(root, "added/private", "keep\n");
    let modified = std::fs::metadata(root.join("added/file"))
        .unwrap()
        .modified()
        .unwrap();
    restore(root, &before).unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("added/file")).unwrap(),
        "snapshot\r\n"
    );
    assert_eq!(
        std::fs::metadata(root.join("added/file"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(
        std::fs::read_to_string(root.join("added/private")).unwrap(),
        "keep\n"
    );
    write(root, "added/file", "private replacement\n");
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_ignored_collision"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("added/file")).unwrap(),
        "private replacement\n"
    );
}
#[test]
fn filesystem_case_and_unicode_aliases_cannot_overwrite_ignored_contents() {
    for (snapshot, ignored) in [("private", "PRIVATE"), ("caf\u{e9}", "CAFE\u{301}")] {
        let dir = repository();
        let root = dir.path();
        write(root, ".gitignore", "*\n");
        write(root, snapshot, "snapshot\n");
        git(root, &["add", "-f", ".gitignore", snapshot]).unwrap();
        git(root, &["commit", "-qm", "base"]).unwrap();
        let before = capture_at(root, "case-alias");
        git(root, &["rm", "--cached", snapshot]).unwrap();
        std::fs::remove_file(root.join(snapshot)).unwrap();
        write(root, ignored, "private\n");
        if !root.join(snapshot).exists() {
            continue;
        }
        let index = index_bytes(root);
        assert_eq!(
            restore(root, &before).unwrap_err().code,
            "checkpoint_ignored_collision"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(ignored)).unwrap(),
            "private\n"
        );
        assert_eq!(index_bytes(root), index);
    }
}
#[cfg(unix)]
#[test]
fn target_directory_symlinks_never_write_into_an_external_repository() {
    let dir = repository();
    let root = dir.path();
    write(root, "nested/a", "snapshot\n");
    commit(root);
    let before = capture_at(root, "symlink-directory");
    let external = tempfile::tempdir().unwrap();
    write(external.path(), "a", "external\n");
    std::fs::remove_dir_all(root.join("nested")).unwrap();
    std::os::unix::fs::symlink(external.path(), root.join("nested")).unwrap();
    assert_eq!(
        restore(root, &before).unwrap_err().code,
        "checkpoint_restore_unavailable"
    );
    assert_eq!(
        std::fs::read_to_string(external.path().join("a")).unwrap(),
        "external\n"
    );
}
#[test]
fn command_deadline_covers_output_pipes_after_git_leader_exit() {
    let dir = repository();
    let started = Instant::now();
    let error = run_with_limit(
        dir.path(),
        &["-c", "alias.hold=!sleep 10 &", "hold"],
        None,
        &[],
        Duration::from_millis(100),
    )
    .err()
    .expect("open descendant pipe times out");
    assert_eq!(error.code, "checkpoint_timeout");
    assert!(started.elapsed() < Duration::from_secs(4));
}
