use super::host::{Entry, validate_entries};
use super::*;
use crate::sandbox::{CodexSource, Desired, Docker, SandboxConfig, docker_binary};
use std::{collections::BTreeMap, time::Instant};

const OWN: &str = "l1code/mirror";

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}
fn commits(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, commit)| (name.to_string(), commit.to_string()))
        .collect()
}
fn branch(name: &str, commit: &str) -> Head {
    Head::Branch {
        name: name.into(),
        commit: commit.into(),
    }
}

#[test]
fn host_head_moves_only_the_own_branch_freely_and_other_branches_by_fast_forward() {
    let mac = MacBranches {
        existing: commits(&[
            ("main", "m1"),
            ("feature", "f1"),
            ("l1code/m", "b1"),
            ("topic", "t1"),
        ]),
        elsewhere: set(&["main", "feature"]),
    };
    let ff = |old: &str, new: &str| (old, new) == ("t1", "t2");
    let head = |container: &Head| host_head(container, &mac, "l1code/m", ff);
    let own = HostHead::Branch {
        name: "l1code/m".into(),
        commit: "b9".into(),
    };
    assert_eq!(
        head(&branch("l1code/m", "b9")),
        own,
        "the thread's own branch follows the container to any commit"
    );
    assert_eq!(
        head(&branch("new", "c1")),
        HostHead::Branch {
            name: "new".into(),
            commit: "c1".into()
        },
        "a branch the Mac does not have is created"
    );
    assert_eq!(
        head(&branch("topic", "t2")),
        HostHead::Branch {
            name: "topic".into(),
            commit: "t2".into()
        },
        "another Mac branch moves by fast-forward"
    );
    assert_eq!(
        head(&branch("topic", "t1")),
        HostHead::Branch {
            name: "topic".into(),
            commit: "t1".into()
        },
        "an unmoved branch is not a rewrite"
    );
    assert_eq!(
        head(&branch("topic", "t3")),
        HostHead::Detached {
            commit: "t3".into(),
            refused_branch: Some("topic".into())
        },
        "a non-fast-forward move of another Mac branch detaches"
    );
    assert_eq!(
        head(&branch("main", "m1")),
        HostHead::Detached {
            commit: "m1".into(),
            refused_branch: Some("main".into())
        },
        "a branch another Mac worktree has checked out never moves, even in place"
    );
    assert_eq!(
        head(&Head::Detached {
            commit: "c3".into()
        }),
        HostHead::Detached {
            commit: "c3".into(),
            refused_branch: None
        }
    );
    assert_eq!(
        head(&Head::Unborn {
            name: "fresh".into()
        }),
        HostHead::Unborn {
            name: "fresh".into()
        }
    );
    assert_eq!(
        head(&Head::Unborn {
            name: "feature".into()
        }),
        HostHead::Unmoved {
            refused_branch: "feature".into()
        },
        "an unborn branch cannot take over an existing Mac branch"
    );
    assert_eq!(head(&branch("main", "m2")).refused_branch(), Some("main"));
}

#[test]
fn head_specs_round_trip_and_reject_mismatched_parents() {
    for head in [
        branch("x/y", "abc"),
        Head::Detached {
            commit: "abc".into(),
        },
        Head::Unborn { name: "x".into() },
    ] {
        assert_eq!(Head::parse(&head.spec(), head.commit()), Some(head));
    }
    assert_eq!(Head::parse("branch x", None), None);
    assert_eq!(Head::parse("detached", None), None);
    assert_eq!(Head::parse("unborn x", Some("abc")), None);
    assert_eq!(Head::parse("merged x", Some("abc")), None);
}

#[test]
fn validate_entries_refuses_gitlinks_dotgit_variants_and_escaping_symlinks() {
    let file = |path: &'static str| Entry {
        mode: "100644",
        path,
        target: None,
    };
    let link = |path: &'static str, target: &'static str| Entry {
        mode: "120000",
        path,
        target: Some(target.as_bytes()),
    };
    validate_entries([
        file("README.md"),
        file("a/b/c.txt"),
        link("a/b/link", "../sibling/file"),
        link("a/b/other", "./c.txt"),
        link("top", "a/b/c.txt"),
        file("notgit/.gitignore"),
        file("git~2/x"),
    ])
    .unwrap();
    let refused = [
        (
            "gitlink",
            Entry {
                mode: "160000",
                path: "sub",
                target: None,
            },
        ),
        ("dotgit", file(".git/config")),
        ("upper", file("x/.GIT/hooks/pre-commit")),
        ("trailing dot", file(".git./hooks/pre-commit")),
        ("ntfs short", file("GIT~1/config")),
        ("absolute", link("l", "/etc/passwd")),
        ("escape", link("a/b/l", "../../../x")),
        ("escape at root", link("l", "../x")),
        ("into dotgit", link("l", ".git/config")),
        ("through dotgit", link("a/l", "../.git/hooks")),
        ("empty target", link("l", "")),
        ("no target", {
            Entry {
                mode: "120000",
                path: "l",
                target: None,
            }
        }),
    ];
    for (why, entry) in refused {
        let error = validate_entries([entry]).unwrap_err();
        assert_eq!(error.code, "mirror_refused", "{why}: {error:?}");
    }
}

#[test]
fn apply_output_is_classified_into_refusals() {
    assert_eq!(
        refusal(b"worktree\tsrc/a.txt\0index\tsrc/b.txt\0worktree\tsrc/a.txt\0"),
        PushRefusal::Diverged {
            paths: vec!["src/a.txt".into(), "src/b.txt".into()],
            head_moved: false
        }
    );
    assert_eq!(
        refusal(b"head\t\0"),
        PushRefusal::Diverged {
            paths: vec![],
            head_moved: true
        }
    );
    assert_eq!(
        refusal(b"worktree\tsrc/a.txt\0blocked\tbuild/out.txt\0"),
        PushRefusal::Blocked {
            path: "build/out.txt".into()
        }
    );
    assert_eq!(
        blocked(
            "error: Untracked working tree file 'build/out.txt' would be overwritten by merge.\n"
        ),
        Some(PushRefusal::Blocked {
            path: "build/out.txt".into()
        })
    );
    assert_eq!(
        blocked("error: Updating 'dir' would lose untracked files in it\n"),
        Some(PushRefusal::Blocked { path: "dir".into() })
    );
    assert_eq!(blocked("fatal: something else\n"), None);
    assert_eq!(
        AppError::from(PushError::Refused(PushRefusal::Blocked {
            path: "x".into()
        }))
        .code,
        "sandbox_blocked"
    );
    assert_eq!(
        AppError::from(PushError::Refused(PushRefusal::Diverged {
            paths: vec![],
            head_moved: true
        }))
        .code,
        "sandbox_diverged"
    );
}

static IMAGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    _data: tempfile::TempDir,
    _repos: tempfile::TempDir,
    main: PathBuf,
    root: PathBuf,
    docker: Docker,
    container: Container,
    mirror: Mirror,
    _removal: Removal,
}
struct Removal(String);
impl Drop for Removal {
    fn drop(&mut self) {
        let _ = crate::process::command(docker_binary())
            .args(["rm", "--force", &self.0])
            .output();
    }
}
const FILES: [(&str, &str); 4] = [
    ("README.md", "# demo\n"),
    ("src/lib.txt", "lib\n"),
    ("bin/tool", "#!/bin/sh\necho tool\n"),
    (".gitignore", "build/\n*.log\n"),
];
impl Fixture {
    async fn new() -> Self {
        Self::with(&FILES).await
    }
    async fn with(files: &[(&str, &str)]) -> Self {
        let data = tempfile::Builder::new()
            .prefix("l1code mirror,test-")
            .tempdir()
            .unwrap();
        let docker = Docker::new(SandboxConfig {
            docker: docker_binary(),
            data_dir: data.path().into(),
            codex: CodexSource::Version("0.162.0".parse().unwrap()),
        });
        {
            let _build = IMAGE.lock().await;
            docker.image(&|_| {}).await.unwrap();
        }
        let repos = tempfile::tempdir().unwrap();
        let main = repos.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["-c", "init.defaultBranch=main", "init", "-q"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", key, value]);
        }
        for (name, contents) in files {
            write(&main, name, contents);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if main.join("bin/tool").exists() {
                std::fs::set_permissions(
                    main.join("bin/tool"),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
        }
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "base"]);
        let mirror_path = repos.path().join("mirror");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "l1code/mirror",
                mirror_path.to_str().unwrap(),
                "main",
            ],
        );
        let root = dunce::canonicalize(&mirror_path).unwrap();
        let container = docker.container(&SandboxId::new());
        let removal = Removal(container.name().to_owned());
        container.converge(Desired::Running).await.unwrap();
        let mirror = Mirror::new(container.clone(), root.clone());
        let started = Instant::now();
        mirror.seed(OWN).await.unwrap();
        eprintln!("seed: {:?}", started.elapsed());
        Self {
            _data: data,
            _repos: repos,
            main,
            root,
            docker,
            container,
            mirror,
            _removal: removal,
        }
    }
    async fn ctr(&self, script: &str) -> String {
        let output = self
            .container
            .run(
                &Exec {
                    argv: &["sh", "-ec", script],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Lifeline,
                Duration::from_secs(120),
            )
            .await
            .unwrap();
        assert_eq!(
            output.code,
            Some(0),
            "{script}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn mac(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }
    fn mac_status(&self) -> Vec<String> {
        status(&git(&self.root, &STATUS))
    }
    async fn ctr_status(&self) -> Vec<String> {
        status(&self.ctr(&format!("git {}", STATUS.join(" "))).await)
    }
    async fn assert_in_sync(&self) {
        assert_eq!(self.mac_status(), self.ctr_status().await, "status");
        assert_eq!(
            self.mac(&["rev-parse", "HEAD"]),
            self.ctr("git rev-parse HEAD").await,
            "HEAD"
        );
    }
    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.root.join(name)).unwrap()
    }
    fn exists(&self, name: &str) -> bool {
        std::fs::symlink_metadata(self.root.join(name)).is_ok()
    }
}
const STATUS: [&str; 6] = [
    "-c",
    "core.excludesFile=/dev/null",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
];
fn status(raw: &str) -> Vec<String> {
    let mut entries: Vec<String> = raw
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    entries.sort();
    entries
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = crate::process::command("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn write(root: &Path, name: &str, contents: &str) {
    if let Some(parent) = root.join(name).parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(root.join(name), contents).unwrap();
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn seed_then_pull_is_a_no_op_and_both_sides_agree() {
    let f = Fixture::new().await;
    assert_eq!(
        f.ctr("test -f /workspace/.git/l1code-seeded && echo yes")
            .await,
        "yes\n"
    );
    assert_eq!(f.ctr("git config user.name").await, "Test\n");
    assert_eq!(
        f.ctr("git symbolic-ref HEAD").await,
        "refs/heads/l1code/mirror\n"
    );
    assert_eq!(
        f.ctr("git remote").await,
        "",
        "no remote and no credentials inside"
    );
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
    assert!(
        f.mirror
            .pull(Freshness::Recent, OWN)
            .await
            .unwrap()
            .is_none()
    );
    f.assert_in_sync().await;
    assert_eq!(f.mac(&["ls-files"]), f.ctr("git ls-files").await);
    let started = Instant::now();
    f.mirror.seed(OWN).await.unwrap();
    eprintln!("second seed (no-op): {:?}", started.elapsed());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn agent_edits_appear_exactly_on_the_mac() {
    let f = Fixture::new().await;
    f.ctr(
        "echo changed > README.md \
         && mkdir -p new/dir && echo fresh > new/dir/file.txt \
         && rm src/lib.txt \
         && mv bin/tool bin/renamed \
         && printf '#!/bin/sh\\n' > run.sh && chmod +x run.sh \
         && ln -s README.md link \
         && mkdir -p build && echo o > build/out.o && echo l > debug.log",
    )
    .await;
    let pulled = f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    eprintln!("pull timing: {:?}", pulled.timing);
    assert!(
        matches!(pulled.host_head, HostHead::Branch { ref name, .. } if name == "l1code/mirror")
    );
    assert_eq!(f.read("README.md"), "changed\n");
    assert_eq!(f.read("new/dir/file.txt"), "fresh\n");
    assert!(!f.exists("src/lib.txt"), "deleted");
    assert!(!f.exists("bin/tool") && f.exists("bin/renamed"), "renamed");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(f.root.join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "executable bit");
        let renamed = std::fs::metadata(f.root.join("bin/renamed"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(renamed & 0o111, 0o111, "executable bit survives the rename");
    }
    assert_eq!(
        std::fs::read_link(f.root.join("link")).unwrap(),
        Path::new("README.md")
    );
    assert!(
        !f.exists("build/out.o") && !f.exists("debug.log"),
        "ignored files stay inside"
    );
    f.assert_in_sync().await;
    assert_eq!(
        f.mirror.pull(Freshness::Exact, OWN).await.unwrap(),
        None,
        "nothing new"
    );

    f.ctr("git add new/dir/file.txt README.md && echo more >> README.md")
        .await;
    let pulled = f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    assert_ne!(pulled.point.index_tree, pulled.point.worktree_tree);
    f.assert_in_sync().await;
    assert!(
        f.mac_status()
            .iter()
            .any(|entry| entry == "A  new/dir/file.txt"),
        "{:?}",
        f.mac_status()
    );
    assert!(
        f.mac_status().iter().any(|entry| entry == "MM README.md"),
        "{:?}",
        f.mac_status()
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn untracked_files_appear_and_deleted_untracked_files_disappear() {
    let f = Fixture::new().await;
    f.ctr("echo s > scratch.txt && mkdir -p tmp/deep && echo d > tmp/deep/x")
        .await;
    f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    assert_eq!(f.read("scratch.txt"), "s\n");
    assert_eq!(f.read("tmp/deep/x"), "d\n");
    f.ctr("rm -r scratch.txt tmp").await;
    f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    assert!(!f.exists("scratch.txt") && !f.exists("tmp/deep/x"));
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_write_sessions_changes_reach_the_container() {
    let f = Fixture::new().await;
    let session = f.mirror.begin_write(OWN).await.unwrap();
    let root: &Path = session.root();
    std::fs::write(root.join("src/lib.txt"), "edited\n").unwrap();
    write(root, "notes/todo.md", "- sync\n");
    std::fs::remove_file(root.join("README.md")).unwrap();
    git(root, &["add", "notes/todo.md"]);
    let started = Instant::now();
    session.finish().await.unwrap();
    eprintln!("push: {:?}", started.elapsed());
    assert_eq!(f.ctr("cat src/lib.txt").await, "edited\n");
    assert_eq!(f.ctr("cat notes/todo.md").await, "- sync\n");
    assert_eq!(f.ctr("test -e README.md || echo gone").await, "gone\n");
    f.assert_in_sync().await;
    assert!(
        f.ctr_status()
            .await
            .contains(&"A  notes/todo.md".to_string())
    );
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_discarded_write_session_leaves_the_container_as_it_was_and_the_mirror_in_sync() {
    let f = Fixture::new().await;
    let session = f.mirror.begin_write(OWN).await.unwrap();
    let root: &Path = session.root();
    std::fs::write(root.join("src/lib.txt"), "half\n").unwrap();
    write(root, "notes/todo.md", "- half\n");
    std::fs::remove_file(root.join("README.md")).unwrap();
    session.discard().await.unwrap();
    assert_eq!(f.ctr("cat src/lib.txt").await, "lib\n");
    assert_eq!(f.ctr("cat README.md").await, "# demo\n");
    assert_eq!(f.ctr("test -e notes/todo.md || echo gone").await, "gone\n");
    assert_eq!(f.read("src/lib.txt"), "lib\n", "the edit is undone");
    assert!(f.exists("README.md"), "the deletion is undone");
    assert!(!f.exists("notes/todo.md"), "the new file is removed");
    f.assert_in_sync().await;
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn push_refuses_with_diverged_when_the_container_changed_the_same_file() {
    let f = Fixture::new().await;
    let session = f.mirror.begin_write(OWN).await.unwrap();
    f.ctr("echo agent > src/lib.txt").await;
    std::fs::write(session.root().join("src/lib.txt"), "host\n").unwrap();
    assert_eq!(
        session.finish().await,
        Err(PushError::Refused(PushRefusal::Diverged {
            paths: vec!["src/lib.txt".into()],
            head_moved: false
        }))
    );
    assert_eq!(
        f.ctr("cat src/lib.txt").await,
        "agent\n",
        "the container is untouched"
    );
    assert_eq!(
        f.read("src/lib.txt"),
        "agent\n",
        "the mirror is pulled back"
    );
    f.assert_in_sync().await;

    let session = f.mirror.begin_write(OWN).await.unwrap();
    f.ctr("echo drift > README.md").await;
    write(session.root(), "other.txt", "host\n");
    session.finish().await.unwrap();
    assert_eq!(
        f.ctr("cat README.md").await,
        "drift\n",
        "container drift on another path stays"
    );
    assert_eq!(f.ctr("cat other.txt").await, "host\n");

    let session = f.mirror.begin_write(OWN).await.unwrap();
    f.ctr("git commit -qam agent-commit").await;
    write(session.root(), "another.txt", "host\n");
    match session.finish().await {
        Err(PushError::Refused(PushRefusal::Diverged { head_moved, .. })) => assert!(head_moved),
        other => panic!("{other:?}"),
    }
    assert!(!f.exists("another.txt"), "the refused write is rolled back");
    assert_eq!(f.mac(&["log", "-1", "--format=%s"]), "agent-commit\n");
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn push_refuses_with_blocked_when_an_ignored_file_is_in_the_way() {
    let f = Fixture::new().await;
    f.ctr("mkdir -p build && echo container > build/out.txt")
        .await;
    let session = f.mirror.begin_write(OWN).await.unwrap();
    write(session.root(), "build/out.txt", "host\n");
    git(session.root(), &["add", "-f", "build/out.txt"]);
    assert_eq!(
        session.finish().await,
        Err(PushError::Refused(PushRefusal::Blocked {
            path: "build/out.txt".into()
        }))
    );
    assert_eq!(f.ctr("cat build/out.txt").await, "container\n");
    assert_eq!(
        f.mac(&["ls-files", "build"]),
        "",
        "the staged file is rolled back"
    );
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_commit_in_the_container_moves_the_mirror_branch() {
    let f = Fixture::new().await;
    let before = f.mac(&["rev-parse", "HEAD"]);
    let mut session = f.mirror.begin_write(OWN).await.unwrap();
    write(session.root(), "src/feature.txt", "feature\n");
    std::fs::write(session.root().join("README.md"), "unstaged\n").unwrap();
    git(session.root(), &["add", "src/feature.txt"]);
    let run = session
        .commit("feat: add feature", COMMIT_LIMIT)
        .await
        .unwrap();
    assert_eq!(run.code, Some(0), "{run:?}");
    session.finish().await.unwrap();
    assert_eq!(
        f.mac(&["log", "-1", "--format=%s %an"]),
        "feat: add feature Test\n"
    );
    assert_ne!(f.mac(&["rev-parse", "HEAD"]), before);
    assert_eq!(
        f.mac(&["symbolic-ref", "HEAD"]),
        "refs/heads/l1code/mirror\n"
    );
    assert_eq!(
        git(&f.main, &["rev-parse", "l1code/mirror"]),
        f.mac(&["rev-parse", "HEAD"]),
        "the branch moved in the shared repository"
    );
    assert_eq!(
        f.mac_status(),
        [" M README.md"],
        "only the unstaged edit remains"
    );
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn seed_after_a_crash_mid_seed_converges() {
    let f = Fixture::new().await;
    f.ctr("rm .git/l1code-seeded && rm -r src && echo junk > junk.txt")
        .await;
    write(&f.root, "uncommitted.txt", "kept\n");
    f.mirror.seed(OWN).await.unwrap();
    assert_eq!(f.ctr("cat src/lib.txt").await, "lib\n");
    assert_eq!(f.ctr("test -e junk.txt || echo gone").await, "gone\n");
    assert_eq!(
        f.ctr("cat uncommitted.txt").await,
        "kept\n",
        "the mirror's state is pushed"
    );
    assert_eq!(
        f.ctr("test -f .git/l1code-seeded && echo yes").await,
        "yes\n"
    );
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
    f.assert_in_sync().await;

    f.ctr("rm -rf /workspace/.git").await;
    f.mirror.seed(OWN).await.unwrap();
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn refused_trees_leave_the_mirror_untouched() {
    let f = Fixture::new().await;
    f.ctr("echo agent > README.md").await;
    f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    let before = (f.mac_status(), f.mac(&["rev-parse", "HEAD"]));
    let base = f.mac(&[
        "rev-parse",
        &format!("refs/l1code/sandbox/{}/base", f.container.id()),
    ]);
    let base = base.trim().to_owned();

    let craft = |worktree_entries: &str| {
        format!(
            "set -e; index=$(git rev-parse 'HEAD^{{tree}}'); \
             blob=$(printf evil | git hash-object -w --stdin); \
             passwd=$(printf /etc/passwd | git hash-object -w --stdin); \
             escape=$(printf ../../../etc/passwd | git hash-object -w --stdin); \
             hooks=$(printf '100755 blob %s\\tpre-commit\\n' $blob | git mktree); \
             dotgit=$(printf '040000 tree %s\\thooks\\n' $hooks | git mktree); \
             wt=$(printf '{worktree_entries} | git mktree); \
             tree=$(printf '040000 tree %s\\tindex\\n040000 tree %s\\tworktree\\n' $index $wt | git mktree); \
             c=$(git commit-tree $tree -p HEAD -m l1code-sync -m 'head: branch l1code/mirror'); \
             git update-ref refs/l1code/sync/outgoing $c; echo $c"
        )
    };
    let cases = [
        (
            "upper-case .GIT directory",
            "040000 tree %s\\t.GIT\\n",
            "$dotgit",
        ),
        (
            "gitlink",
            "160000 commit %s\\tsub\\n",
            "$(git rev-parse HEAD)",
        ),
        ("absolute symlink", "120000 blob %s\\tlink\\n", "$passwd"),
        ("escaping symlink", "120000 blob %s\\tlink\\n", "$escape"),
        ("ntfs short name", "040000 tree %s\\tGIT~1\\n", "$dotgit"),
    ];
    for (why, entry, value) in cases {
        let script = craft(&format!("{entry}' {value}"));
        let outgoing = f.ctr(&script).await.trim().to_owned();
        let error = f
            .mirror
            .adopt(outgoing, Some(base.clone()), Duration::ZERO, OWN)
            .await
            .unwrap_err();
        eprintln!("{why}: {} {}", error.code, error.message);
        assert!(
            ["mirror_refused", "mirror"].contains(&error.code.as_str()),
            "{why}: {error:?}"
        );
        assert_eq!(
            (f.mac_status(), f.mac(&["rev-parse", "HEAD"])),
            before,
            "{why}"
        );
        assert!(
            !f.exists(".GIT/hooks") && !f.exists("sub") && !f.exists("link") && !f.exists("GIT~1"),
            "{why}"
        );
    }

    f.ctr(
        "git init -q /tmp/sub && git -C /tmp/sub -c user.name=Sub -c user.email=sub@example.invalid commit -q --allow-empty -m sub \
         && git -c protocol.file.allow=always submodule add -q /tmp/sub sub",
    )
    .await;
    let error = f.mirror.pull(Freshness::Exact, OWN).await.unwrap_err();
    assert_eq!(error.code, "mirror_refused", "{error:?}");
    assert!(!f.exists("sub") && !f.exists(".gitmodules"));
    f.ctr("git rm -qf sub && rm -rf .git/modules .gitmodules && git rm -qf --cached .gitmodules 2>/dev/null || true").await;
    f.ctr("ln -s ../../etc/passwd escape").await;
    let error = f.mirror.pull(Freshness::Exact, OWN).await.unwrap_err();
    assert_eq!(error.code, "mirror_refused", "{error:?}");
    assert!(!f.exists("escape"));
    f.ctr("rm escape && mkdir .GIT && echo h > .GIT/hook").await;
    f.mirror.pull(Freshness::Exact, OWN).await.unwrap();
    assert!(
        !f.exists(".GIT/hook"),
        "git itself never indexes a .GIT path"
    );
    assert_eq!((f.mac_status(), f.mac(&["rev-parse", "HEAD"])), before);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn container_config_and_hooks_never_run_on_the_mac() {
    let f = Fixture::new().await;
    let marker = format!("/tmp/l1code-mirror-{}", f.container.id());
    let plant = format!(
        "mkdir -p /home/l1code/hooks && for h in pre-commit post-commit post-index-change \
           reference-transaction post-checkout pre-receive post-receive update; do \
           printf \"#!/bin/sh\\ntouch {marker}-$h\\nexit 0\\n\" > /home/l1code/hooks/$h; \
           chmod +x /home/l1code/hooks/$h; done \
         && git config core.hooksPath /home/l1code/hooks \
         && git config core.fsmonitor \"sh -c 'touch {marker}-fsmonitor; exit 1'\""
    );
    f.ctr(&plant).await;
    f.ctr("echo agent > README.md").await;
    f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    let mut session = f.mirror.begin_write(OWN).await.unwrap();
    write(session.root(), "host.txt", "host\n");
    git(session.root(), &["add", "host.txt"]);
    let run = session.commit("host commit", COMMIT_LIMIT).await.unwrap();
    assert_eq!(run.code, Some(0), "{run:?}");
    session.finish().await.unwrap();
    f.ctr("git status --short >/dev/null").await;

    let on_mac: Vec<_> = std::fs::read_dir("/tmp")
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(&format!("l1code-mirror-{}", f.container.id())))
        .collect();
    assert!(on_mac.is_empty(), "the Mac ran container hooks: {on_mac:?}");
    let in_container = f.ctr(&format!("ls {marker}-* | xargs -n1 basename")).await;
    assert!(
        in_container.contains("fsmonitor"),
        "the planted config is live: {in_container}"
    );
    assert!(
        in_container.contains("pre-commit"),
        "the commit ran hooks inside: {in_container}"
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn host_head_refuses_to_move_a_branch_checked_out_elsewhere_on_the_mac() {
    let f = Fixture::new().await;
    let main_before = git(&f.main, &["rev-parse", "main"]);
    f.ctr("git checkout -qb main && echo m > on-main.txt && git add on-main.txt && git commit -qm on-main").await;
    let pulled = f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    let agent_commit = f.ctr("git rev-parse HEAD").await;
    assert_eq!(
        pulled.host_head,
        HostHead::Detached {
            commit: agent_commit.trim().into(),
            refused_branch: Some("main".into())
        }
    );
    assert_eq!(
        git(&f.main, &["rev-parse", "main"]),
        main_before,
        "the Mac's main did not move"
    );
    assert_eq!(f.mac(&["rev-parse", "HEAD"]), agent_commit);
    assert!(
        !crate::process::command("git")
            .args(["-C", f.root.to_str().unwrap(), "symbolic-ref", "-q", "HEAD"])
            .output()
            .unwrap()
            .status
            .success(),
        "the mirror is detached"
    );
    assert_eq!(f.read("on-main.txt"), "m\n");
    assert_eq!(f.mac_status(), f.ctr_status().await);

    f.ctr("git checkout -q l1code/mirror").await;
    let pulled = f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    assert!(
        matches!(pulled.host_head, HostHead::Branch { ref name, .. } if name == "l1code/mirror")
    );
    assert_eq!(
        f.mac(&["symbolic-ref", "HEAD"]),
        "refs/heads/l1code/mirror\n"
    );
    assert!(!f.exists("on-main.txt"));
    f.assert_in_sync().await;
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn an_exact_sync_holds_the_mirror_lock_until_dropped() {
    let f = Fixture::new().await;
    let guard = f.mirror.sync(Freshness::Exact, OWN).await.unwrap();
    let mirror = f.mirror.clone();
    let mut waiting = tokio::spawn(async move { mirror.pull(Freshness::Recent, OWN).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(500), &mut waiting)
            .await
            .is_err(),
        "a pull must wait for the guard"
    );
    drop(guard);
    assert_eq!(waiting.await.unwrap().unwrap(), None);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_stopped_container_makes_pull_a_no_op() {
    let f = Fixture::new().await;
    f.container.converge(Desired::Stopped).await.unwrap();
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
    f.container.converge(Desired::Running).await.unwrap();
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn timing_on_a_twenty_thousand_file_repository() {
    let files: Vec<(String, String)> = (0..20_000)
        .map(|i| {
            (
                format!("src/pkg{:03}/mod{:03}/file{i}.txt", i % 200, i % 97),
                format!("line one of file {i}\nline two\n"),
            )
        })
        .chain([(".gitignore".to_string(), "build/\n".to_string())])
        .collect();
    let borrowed: Vec<(&str, &str)> = files
        .iter()
        .map(|(name, contents)| (name.as_str(), contents.as_str()))
        .collect();
    let f = Fixture::with(&borrowed).await;
    let started = Instant::now();
    assert_eq!(f.mirror.pull(Freshness::Exact, OWN).await.unwrap(), None);
    eprintln!("no-change pull: {:?}", started.elapsed());
    f.ctr(
        "git ls-files | head -50 | while read -r f; do echo edited >> \"$f\"; done; \
         for i in 1 2 3 4 5; do echo new > src/new$i.txt; done; \
         git ls-files | tail -2 | xargs rm",
    )
    .await;
    let started = Instant::now();
    let pulled = f.mirror.pull(Freshness::Exact, OWN).await.unwrap().unwrap();
    eprintln!(
        "pull with 50 modified, 5 new, 2 deleted: total {:?}, {:?}",
        started.elapsed(),
        pulled.timing
    );
    f.assert_in_sync().await;
    let session = f.mirror.begin_write(OWN).await.unwrap();
    write(session.root(), "src/from-host.txt", "host\n");
    let started = Instant::now();
    session.finish().await.unwrap();
    eprintln!("push with one new file: {:?}", started.elapsed());
    assert_eq!(f.ctr("cat src/from-host.txt").await, "host\n");
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_stale_container_without_the_desktop_port_is_pulled_then_recreated_with_it() {
    use crate::sandbox::{DESKTOP_PORT, IMAGE_LABEL, INSTANCE_LABEL, SANDBOX_LABEL};
    let f = Fixture::new().await;
    let docker = |args: &[&str]| {
        let output = crate::process::command(docker_binary())
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "docker {args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    let name = f.container.name();
    let image = f.docker.image(&|_| {}).await.unwrap();
    let home = f.container.codex_home();
    docker(&["rm", "--force", name]);
    docker(&[
        "create",
        "--name",
        name,
        "--init",
        "--label",
        &format!("{INSTANCE_LABEL}={}", f.docker.instance().as_str()),
        "--label",
        &format!("{SANDBOX_LABEL}={}", f.container.id()),
        "--label",
        &format!("{IMAGE_LABEL}=000000000000"),
        "--volume",
        &format!("{}:{}", home.display(), crate::sandbox::CODEX_HOME),
        &image.tag(),
    ]);
    docker(&["start", name]);
    f.mirror.seed(OWN).await.unwrap();
    assert!(f.container.published(DESKTOP_PORT).await.is_err());
    f.ctr("echo from the old container > agent.txt").await;

    let handle = crate::workdir::SandboxHandle::new(
        f.docker.clone(),
        f.container.id().clone(),
        f.root.clone(),
        OWN.into(),
        std::time::Duration::from_secs(30),
        tokio::sync::mpsc::unbounded_channel().0,
        crate::log::RotatingLog::silent(),
    );
    handle.ready().await.unwrap();
    assert_eq!(
        f.read("agent.txt"),
        "from the old container\n",
        "the old container was pulled before its removal"
    );
    assert_eq!(
        docker(&[
            "container",
            "inspect",
            "--format",
            &format!("{{{{index .Config.Labels \"{IMAGE_LABEL}\"}}}}"),
            name
        ])
        .trim(),
        image.as_str()
    );
    let port = f.container.published(DESKTOP_PORT).await.unwrap();
    eprintln!("recreated with the desktop on 127.0.0.1:{port}");
    assert_eq!(
        f.ctr("cat agent.txt").await,
        "from the old container\n",
        "the new container is seeded from the mirror"
    );
    let desktop = handle.desktop().await.unwrap();
    assert_eq!(desktop.port, port);
}
