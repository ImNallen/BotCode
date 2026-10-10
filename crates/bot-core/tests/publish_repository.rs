#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
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
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn executable(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}
struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    bare: PathBuf,
    config: RuntimeConfig,
}
impl Fixture {
    fn new(committed: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        if committed {
            std::fs::write(root.join("README"), "original\n").unwrap();
            git(&root, &["add", "README"]);
            git(&root, &["commit", "-qm", "Initial"]);
        }
        let bare = dir.path().join("published.git");
        git(
            dir.path(),
            &["init", "-q", "--bare", bare.to_str().unwrap()],
        );
        let key = format!("url.{}.insteadOf", bare.display());
        for url in [
            "git@github.com:Canonical/New-Repo.git",
            "https://github.com/Canonical/New-Repo.git",
            "https://github.com/canonical/new-repo",
            "ssh://git@github.com/canonical/new-repo.git",
        ] {
            git(&root, &["config", "--add", &key, url]);
        }
        let gh = dir.path().join("gh");
        executable(
            &gh,
            r#"#!/usr/bin/env python3
import json, os, pathlib, sys, time
base = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (base / 'calls.jsonl').open('a') as file:
    file.write(json.dumps({'args': args, 'host': os.environ.get('GH_HOST'), 'prompt': os.environ.get('GH_PROMPT_DISABLED')}) + '\n')
mode = (base / 'mode').read_text() if (base / 'mode').exists() else ''
if args[:2] == ['auth', 'status']:
    if mode == 'signedout':
        print('secret-auth-dump', file=sys.stderr); sys.exit(1)
    if mode == 'autherror': sys.exit(2)
    sys.exit(0)
if args[:1] == ['api']:
    if mode == 'apierror': sys.exit(1)
    print('Canonical'); sys.exit(0)
if args[:2] == ['repo', 'create']:
    (base / 'creating').touch()
    if mode == 'race':
        (base / args[2].split('/')[-1]).touch()
        while not (base / 'first').exists() or not (base / 'second').exists(): time.sleep(.01)
        print('https://github.com/' + args[2]); sys.exit(0)
    if mode == 'hold':
        while not (base / 'release').exists(): time.sleep(.02)
    if mode == 'timeout': time.sleep(10)
    if mode == 'reject': print('GraphQL: permission denied; secret-create-dump ghp_example_not_a_real_token', file=sys.stderr); sys.exit(1)
    if mode == 'networkerror': print('Post https://api.github.com/graphql: unexpected EOF', file=sys.stderr); sys.exit(1)
    if mode == 'badoutput': print('https://enterprise.invalid/owner/name'); sys.exit(0)
    if mode == 'lock': (pathlib.Path.cwd() / '.git' / 'config.lock').touch()
    print('https://github.com/Canonical/New-Repo'); sys.exit(0)
raise SystemExit('Unexpected gh command ' + repr(args))
"#,
        );
        let codex = dir.path().join("codex");
        executable(&codex, include_str!("support/codex_peer.py"));
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            gh_binary: gh,
            codex_binary: codex,
            network_timeout: Duration::from_secs(3),
            shell: None,
        };
        Self {
            dir,
            root,
            bare,
            config,
        }
    }
    fn mode(&self, mode: &str) {
        std::fs::write(self.dir.path().join("mode"), mode).unwrap();
    }
    async fn open(&self) -> (App, WorkspaceId) {
        let app = App::open(self.config.clone()).await.unwrap();
        let id = app.open_workspace(self.root.clone()).await.unwrap().id;
        (app, id)
    }
    fn calls(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn input(&self) -> PublishInput {
        PublishInput {
            repository: "canonical/new-repo".into(),
            visibility: RepositoryVisibility::Private,
            remote_name: "origin".into(),
            protocol: CloneProtocol::Ssh,
        }
    }
}
#[tokio::test]
async fn publish_defaults_preserve_dirty_files_and_use_canonical_created_url_without_view() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    std::fs::write(f.root.join("README"), "dirty\n").unwrap();
    std::fs::write(f.root.join("untracked"), "keep\n").unwrap();
    std::fs::write(f.root.join("staged"), "keep in index\n").unwrap();
    git(&f.root, &["add", "staged"]);
    let before = git(&f.root, &["status", "--porcelain"]);
    let outcome = app.publish_repository(id, None, f.input()).await.unwrap();
    let PublishOutcome::Succeeded {
        result:
            PublishResult::Pushed {
                remote,
                branch,
                upstream_branch,
            },
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    assert_eq!(remote.repository.name_with_owner, "Canonical/New-Repo");
    assert_eq!(
        remote.repository.url,
        "https://github.com/Canonical/New-Repo"
    );
    assert_eq!(remote.remote_url, "git@github.com:Canonical/New-Repo.git");
    assert_eq!(branch, "main");
    assert_eq!(upstream_branch, "origin/main");
    assert_eq!(
        git(&f.root, &["rev-parse", "HEAD"]),
        git(&f.bare, &["rev-parse", "refs/heads/main"])
    );
    assert_eq!(
        git(&f.root, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/main"
    );
    assert_eq!(git(&f.root, &["status", "--porcelain"]), before);
    assert_eq!(
        std::fs::read_to_string(f.root.join("README")).unwrap(),
        "dirty\n"
    );
    let calls = f.calls();
    assert!(calls.iter().any(|c| c["args"] == serde_json::json!(["auth", "status", "--hostname", "github.com"])));
    assert!(calls.iter().any(|c| c["args"]
        == serde_json::json!(["api", "--hostname", "github.com", "user", "--jq", ".login"])));
    assert!(
        calls
            .iter()
            .all(|c| c["host"] == "github.com" && c["prompt"] == "1")
    );
    assert!(
        calls.iter().any(|c| c["args"]
            == serde_json::json!(["repo", "create", "canonical/new-repo", "--private"]))
    );
    assert!(!calls.iter().any(|c| c["args"][1] == "view"));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn empty_public_https_uses_collision_suffix_without_pushing_or_replacing_origin() {
    let f = Fixture::new(false);
    let (app, id) = f.open().await;
    git(
        &f.root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/unrelated/existing.git",
        ],
    );
    let mut input = f.input();
    input.visibility = RepositoryVisibility::Public;
    input.protocol = CloneProtocol::Https;
    input.remote_name = "  ".into();
    let outcome = app.publish_repository(id, None, input).await.unwrap();
    let PublishOutcome::Succeeded {
        result: PublishResult::RemoteAdded { remote, branch },
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    assert_eq!(branch, "main");
    assert_eq!(remote.remote_name, "origin-1");
    assert_eq!(
        remote.remote_url,
        "https://github.com/Canonical/New-Repo.git"
    );
    assert_eq!(
        git(&f.root, &["config", "remote.origin.url"]),
        "https://github.com/unrelated/existing.git"
    );
    assert!(git(&f.bare, &["for-each-ref"]).is_empty());
    assert!(f.calls().iter().any(|c| c["args"][3] == "--public"));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn readiness_is_app_wide_and_distinguishes_signedout_missing_and_failed() {
    let f = Fixture::new(false);
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(
        matches!(app.github_publish_readiness().await.unwrap(), PublishReadiness::Ready { account } if account == "Canonical")
    );
    for (mode, expected) in [
        ("signedout", "unauthenticated"),
        ("autherror", "failed"),
        ("apierror", "failed"),
    ] {
        f.mode(mode);
        let readiness =
            serde_json::to_value(app.github_publish_readiness().await.unwrap()).unwrap();
        assert_eq!(readiness["reason"], expected);
        assert!(!readiness.to_string().contains("secret-auth-dump"));
    }
    std::fs::remove_file(&f.config.gh_binary).unwrap();
    assert!(
        matches!(app.github_publish_readiness().await.unwrap(), PublishReadiness::Unavailable { reason: PublishUnavailable::Missing, hint } if hint.contains("gh auth login --hostname github.com"))
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn invalid_inputs_and_detached_head_do_not_create_a_repository() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    for repository in [
        "name",
        "https://github.com/owner/name",
        "owner/name/extra",
        "-owner/name",
        "owner/a b",
    ] {
        let mut input = f.input();
        input.repository = repository.into();
        assert!(
            app.publish_repository(id.clone(), None, input)
                .await
                .is_err()
        );
    }
    for remote in ["-origin", "bad..name", "has space"] {
        let mut input = f.input();
        input.remote_name = remote.into();
        assert!(
            app.publish_repository(id.clone(), None, input)
                .await
                .is_err()
        );
    }
    git(&f.root, &["checkout", "--detach", "-q"]);
    assert!(app.publish_repository(id, None, f.input()).await.is_err());
    assert!(f.calls().is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn same_identity_reuses_protocols_but_conflicting_fetch_or_push_urls_are_not_adopted() {
    for conflict in ["none", "fetch", "push"] {
        let f = Fixture::new(true);
        let (app, id) = f.open().await;
        git(
            &f.root,
            &[
                "remote",
                "add",
                "existing",
                "https://github.com/canonical/new-repo",
            ],
        );
        git(
            &f.root,
            &[
                "config",
                "--add",
                "remote.existing.pushurl",
                "ssh://git@github.com/canonical/new-repo.git",
            ],
        );
        git(
            &f.root,
            &[
                "config",
                "--add",
                "remote.existing.url",
                "https://GitHub.com:443/Canonical/New-Repo.git/",
            ],
        );
        if conflict != "none" {
            git(
                &f.root,
                &[
                    "config",
                    "--add",
                    if conflict == "push" {
                        "remote.existing.pushurl"
                    } else {
                        "remote.existing.url"
                    },
                    "https://github.com/elsewhere/unrelated.git",
                ],
            );
        }
        let before = git(&f.root, &["config", "--get-regexp", "remote.existing"]);
        let outcome = app.publish_repository(id, None, f.input()).await.unwrap();
        let PublishOutcome::Succeeded {
            result: PublishResult::Pushed { remote, .. },
        } = outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!(
            remote.remote_name,
            if conflict == "none" {
                "existing"
            } else {
                "origin"
            }
        );
        assert_eq!(
            git(&f.root, &["config", "--get-regexp", "remote.existing"]),
            before
        );
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn rejected_push_retains_created_identity_and_selected_remote_recovery() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    executable(
        &f.bare.join("hooks/pre-receive"),
        "#!/bin/sh\necho 'POLICY123: commit rejected because the required ticket is missing' >&2\nexit 1\n",
    );
    git(
        &f.root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/unrelated/existing.git",
        ],
    );
    let outcome = app
        .publish_repository(id.clone(), None, f.input())
        .await
        .unwrap();
    let PublishOutcome::Failed {
        message,
        completed: PublishCompleted::RemoteAdded { remote },
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    assert!(
        message.contains("POLICY123: commit rejected because the required ticket is missing"),
        "{message}"
    );
    assert!(!message.contains("HEAD:"));
    assert_eq!(remote.remote_name, "origin-1");
    assert_eq!(remote.repository.name_with_owner, "Canonical/New-Repo");
    assert!(
        message.contains("git push --set-upstream -- 'origin-1' 'refs/heads/main:refs/heads/main'")
    );
    assert!(git(&f.bare, &["for-each-ref"]).is_empty());
    app.switch_branch(id, None, "after".into(), true)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn failed_remote_add_retains_created_repository_and_does_not_claim_push_succeeded() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    f.mode("lock");
    let outcome = app
        .publish_repository(id.clone(), None, f.input())
        .await
        .unwrap();
    assert!(
        matches!(outcome, PublishOutcome::Failed { completed: PublishCompleted::RepositoryCreated { repository }, message } if repository.name_with_owner == "Canonical/New-Repo" && message.contains("could not lock config file") && message.contains("config") && message.contains("do not create the repository again"))
    );
    std::fs::remove_file(f.root.join(".git/config.lock")).unwrap();
    app.switch_branch(id, None, "after".into(), true)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn known_rejection_differs_from_timeout_and_unusable_create_success() {
    for mode in ["reject", "timeout", "badoutput", "networkerror"] {
        let mut f = Fixture::new(true);
        f.config.network_timeout = Duration::from_secs(1);
        let (app, id) = f.open().await;
        f.mode(mode);
        let outcome = app
            .publish_repository(id.clone(), None, f.input())
            .await
            .unwrap();
        let message = match &outcome {
            PublishOutcome::Failed { message, .. }
            | PublishOutcome::CreationUncertain { message, .. } => message,
            _ => panic!("{outcome:?}"),
        };
        match mode {
            "reject" => {
                assert!(message.contains("denied permission"), "{message}");
                assert!(
                    !message.contains("secret-create-dump") && !message.contains("ghp_"),
                    "{message}"
                );
            }
            "timeout" => assert!(message.contains("timed out"), "{message}"),
            "networkerror" => assert!(message.contains("connection"), "{message}"),
            "badoutput" => assert!(message.contains("URL"), "{message}"),
            _ => unreachable!(),
        }
        if mode == "reject" {
            assert!(matches!(
                outcome,
                PublishOutcome::Failed {
                    completed: PublishCompleted::Nothing,
                    ..
                }
            ));
        } else {
            assert!(matches!(outcome, PublishOutcome::CreationUncertain { .. }));
        }
        assert!(git(&f.root, &["remote"]).is_empty());
        app.switch_branch(id, None, "after".into(), true)
            .await
            .unwrap();
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn owner_stays_responsive_and_holds_checkout_until_publish_finishes() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    f.mode("hold");
    let thread = app
        .create_thread(id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let run = app.publish_repository(id.clone(), None, f.input());
    tokio::pin!(run);
    tokio::select! {
        value = &mut run => panic!("early {value:?}"),
        _ = async { while !f.dir.path().join("creating").exists() { tokio::time::sleep(Duration::from_millis(10)).await; } } => {},
    }
    tokio::time::timeout(Duration::from_secs(1), app.list_workspaces())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        app.switch_branch(id.clone(), None, "after".into(), true)
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    assert_eq!(
        app.publish_repository(id.clone(), None, f.input())
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    assert_eq!(
        app.remove_workspace(id.clone()).await.unwrap_err().code,
        "busy"
    );
    assert_eq!(
        app.submit(
            thread.id.clone(),
            "during-publish".into(),
            "hello".into(),
            vec![]
        )
        .await
        .unwrap_err()
        .code,
        "checkout_busy"
    );
    assert_eq!(app.delete_thread(thread.id).await.unwrap_err().code, "busy");
    std::fs::write(f.dir.path().join("release"), "").unwrap();
    assert!(matches!(
        run.await.unwrap(),
        PublishOutcome::Succeeded { .. }
    ));
    app.switch_branch(id, None, "after".into(), true)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn shutdown_drains_publication_and_its_checkout_hold() {
    let mut f = Fixture::new(true);
    f.config.network_timeout = Duration::from_secs(1);
    let (app, id) = f.open().await;
    f.mode("timeout");
    let run = app.publish_repository(id, None, f.input());
    tokio::pin!(run);
    tokio::select! { value = &mut run => panic!("early {value:?}"), _ = async { while !f.dir.path().join("creating").exists() { tokio::time::sleep(Duration::from_millis(10)).await; } } => {} }
    app.shutdown().await.unwrap();
    assert!(matches!(
        run.await.unwrap(),
        PublishOutcome::CreationUncertain { .. }
    ));
}

#[tokio::test]
async fn linked_worktree_publications_preserve_both_remote_identities() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    let linked = f.dir.path().join("linked");
    git(
        &f.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    let thread = app
        .create_thread(id.clone(), NewCheckout::Registered { path: linked })
        .await
        .unwrap();
    for url in [
        "git@github.com:Canonical/first.git",
        "git@github.com:Canonical/second.git",
    ] {
        git(
            &f.root,
            &[
                "config",
                "--add",
                &format!("url.{}.insteadOf", f.bare.display()),
                url,
            ],
        );
    }
    f.mode("race");
    let mut first = f.input();
    first.repository = "Canonical/first".into();
    let mut second = f.input();
    second.repository = "Canonical/second".into();
    let (one, two) = tokio::join!(
        app.publish_repository(id.clone(), None, first),
        app.publish_repository(id, Some(thread.id), second)
    );
    for outcome in [one.unwrap(), two.unwrap()] {
        assert!(
            matches!(outcome, PublishOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
    }
    let mut urls = [
        git(&f.root, &["config", "remote.origin.url"]),
        git(&f.root, &["config", "remote.origin-1.url"]),
    ];
    urls.sort();
    assert_eq!(
        urls,
        [
            "git@github.com:Canonical/first.git",
            "git@github.com:Canonical/second.git"
        ]
    );
    assert!(!git(&f.bare, &["rev-parse", "refs/heads/main"]).is_empty());
    assert!(!git(&f.bare, &["rev-parse", "refs/heads/linked"]).is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn broken_head_is_refused_instead_of_being_reported_as_no_commits() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    std::fs::write(
        f.root.join(".git/refs/heads/main"),
        "1111111111111111111111111111111111111111\n",
    )
    .unwrap();
    assert!(app.publish_repository(id, None, f.input()).await.is_err());
    assert!(f.calls().is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn rejected_push_quotes_a_valid_remote_name_with_a_quote() {
    let f = Fixture::new(true);
    let (app, id) = f.open().await;
    executable(&f.bare.join("hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
    let mut input = f.input();
    input.remote_name = "team'copy".into();
    let outcome = app.publish_repository(id, None, input).await.unwrap();
    let PublishOutcome::Failed {
        message,
        completed: PublishCompleted::RemoteAdded { remote },
    } = outcome
    else {
        panic!("{outcome:?}")
    };
    assert_eq!(remote.remote_name, "team'copy");
    assert!(message.contains("'team'\\''copy'"), "{message}");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn repository_spelling_with_a_leading_hyphen_is_not_mistaken_for_a_cli_option() {
    let f = Fixture::new(false);
    let (app, id) = f.open().await;
    let mut input = f.input();
    input.repository = "Canonical/-new_repo.name".into();
    assert!(matches!(
        app.publish_repository(id, None, input).await.unwrap(),
        PublishOutcome::Succeeded { .. }
    ));
    assert!(f.calls().iter().any(|c| c["args"]
        == serde_json::json!(["repo", "create", "Canonical/-new_repo.name", "--private"])));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkout_changes_during_creation_retain_remote_without_publishing() {
    for change in ["branch", "commit", "unborn", "broken"] {
        let f = Fixture::new(change != "unborn");
        let (app, id) = f.open().await;
        f.mode("hold");
        let publication = app.publish_repository(id.clone(), None, f.input());
        let mutate = async {
            while !f.dir.path().join("creating").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if change == "broken" {
                std::fs::write(
                    f.root.join(".git/refs/heads/main"),
                    "1111111111111111111111111111111111111111\n",
                )
                .unwrap();
            } else {
                if change == "branch" {
                    git(&f.root, &["switch", "-qc", "other"]);
                }
                std::fs::write(f.root.join("CHANGED"), "created during publication\n").unwrap();
                git(&f.root, &["add", "CHANGED"]);
                git(&f.root, &["commit", "-qm", "Concurrent commit"]);
            }
            std::fs::write(f.dir.path().join("release"), "").unwrap();
        };
        let (outcome, _) = tokio::join!(publication, mutate);
        let outcome = outcome.unwrap();
        let PublishOutcome::Failed {
            message,
            completed: PublishCompleted::RemoteAdded { remote },
        } = outcome
        else {
            panic!("{change}: {outcome:?}");
        };
        assert_eq!(remote.repository.name_with_owner, "Canonical/New-Repo");
        assert_eq!(remote.remote_name, "origin");
        assert_eq!(
            git(&f.root, &["config", "remote.origin.url"]),
            remote.remote_url
        );
        assert!(git(&f.bare, &["for-each-ref"]).is_empty(), "{change}");
        assert!(
            git(
                &f.root,
                &["for-each-ref", "--format=%(upstream)", "refs/heads/"]
            )
            .is_empty()
        );
        assert!(message.contains("Inspect this checkout"), "{message}");
        assert!(
            message.contains("Do not create the repository again"),
            "{message}"
        );
        assert!(
            !message.contains("HEAD:") && !message.contains("no commits"),
            "{message}"
        );
        assert_eq!(
            f.calls().iter().filter(|c| c["args"][0] == "repo").count(),
            1
        );
        app.shutdown().await.unwrap();
    }
}
