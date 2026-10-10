#!/usr/bin/env python3
import argparse
import json
import pathlib
import shutil
import sqlite3
import subprocess
import time
import uuid


def git(repository, *arguments):
    return subprocess.check_output(
        ["git", "-C", str(repository), *arguments],
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()


def github_peer(root):
    source = pathlib.Path(__file__).resolve().parents[1] / "crates/bot-core/tests/fixtures/gh-lifecycle.py"
    peer = root / "peers/gh"
    peer.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, subprocess, sys, time\n"
        "root = pathlib.Path(__file__).resolve().parents[1]\n"
        "arguments = sys.argv[1:]\n"
        "entry = {'args': arguments, 'cwd': os.getcwd(), 'host': os.environ.get('GH_HOST')}\n"
        "if '--body-file' in arguments:\n"
        "    entry['body'] = pathlib.Path(arguments[arguments.index('--body-file') + 1]).read_text()\n"
        "with (root / 'gh-calls.jsonl').open('a') as log:\n"
        "    log.write(json.dumps(entry) + '\\n')\n"
        "state_path = root / 'gh.json'\n"
        "state = json.loads(state_path.read_text())\n"
        "query = ' '.join(arguments)\n"
        "if arguments == ['--version']:\n"
        "    print('gh version 2.80.0 (native fixture)'); sys.exit(0)\n"
        "if arguments[:2] == ['auth', 'status'] or (arguments[:1] == ['api'] and (('viewer' in query and 'repository' not in query) or 'user' in arguments)):\n"
        "    if state.get('signedOut'):\n"
        "        print('You are not logged into any GitHub hosts. Run gh auth login.', file=sys.stderr); sys.exit(1)\n"
        "    account = state.get('viewer', 'fixture')\n"
        "    if arguments[:2] == ['auth', 'status']:\n"
        "        print('github.com: Logged in as ' + account)\n"
        "    elif 'graphql' in arguments:\n"
        "        print(json.dumps({'data': {'viewer': {'login': account}}}))\n"
        "    elif '--jq' in arguments or '-q' in arguments:\n"
        "        print(account)\n"
        "    else:\n"
        "        print(json.dumps({'login': account}))\n"
        "    sys.exit(0)\n"
        "if arguments[:2] == ['repo', 'create']:\n"
        "    time.sleep(state.get('publishDelay', 0))\n"
        "    if state.get('failPublish'):\n"
        "        print('Fixture repository creation denied.', file=sys.stderr); sys.exit(1)\n"
        "    state.setdefault('publishedRepositories', []).append(arguments[2])\n"
        "    state_path.write_text(json.dumps(state))\n"
        "    print('https://github.com/' + arguments[2]); sys.exit(0)\n"
        "if arguments[:2] == ['pr', 'create'] and state.get('captureGitAtCreate'):\n"
        "    state['head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()\n"
        "    for flag, field in (('--head', 'branch'), ('--base', 'base')):\n"
        "        if flag in arguments: state[field] = arguments[arguments.index(flag) + 1]\n"
        "    state_path.write_text(json.dumps(state))\n"
        f"os.execv({str(source)!r}, [{str(source)!r}, *arguments])\n"
    )
    peer.chmod(0o755)
    return peer


def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    source = pathlib.Path(__file__).resolve().parents[1]
    state, peers, repository = (root / name for name in ("state", "peers", "repository"))
    for directory in (state, peers, repository):
        directory.mkdir()
    shutil.copy(source / "crates/bot-core/tests/support/codex_peer.py", peers / "codex")
    (peers / "codex").chmod(0o755)
    (peers / "commit_output").write_text(json.dumps({"subject": "feat: native settings", "body": ""}))
    (peers / "pr_output").write_text(json.dumps({"title": "Native settings", "body": "## Fixture template\nNative verification."}))
    git(repository, "init", "-q", "-b", "main")
    git(repository, "config", "user.name", "Native verifier")
    git(repository, "config", "user.email", "verify@example.invalid")
    (repository / "README.md").write_text("Disposable source control verification.\n")
    (repository / "AGENTS.md").write_text("Use the NATIVE_REPO_CONVENTIONS marker in descriptions.\n")
    (repository / ".github").mkdir()
    (repository / ".github/pull_request_template.md").write_text("## NATIVE_TEMPLATE\nDescribe the tested behavior.\n")
    git(repository, "add", "-A")
    git(repository, "commit", "-qm", "feat: initial fixture")
    before = git(repository, "rev-parse", "HEAD")
    remote = root / "remote.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(repository), str(remote)], check=True)
    git(repository, "remote", "add", "origin", "https://github.com/fixture/project.git")
    git(repository, "config", f"url.{remote}.insteadOf", "https://github.com/fixture/project.git")
    git(repository, "fetch", "origin")
    git(repository, "remote", "set-head", "origin", "-a")
    git(repository, "branch", "--set-upstream-to=origin/main", "main")
    git(repository, "switch", "-qc", "feature/review")
    (repository / "review.txt").write_text("Review fixture.\n")
    git(repository, "add", "-A")
    git(repository, "commit", "-qm", "feat: review fixture")
    head = git(repository, "rev-parse", "HEAD")
    git(repository, "push", "-u", "origin", "feature/review")
    git(repository, "switch", "main")
    upstream = root / "upstream"
    subprocess.run(["git", "clone", "-q", str(remote), str(upstream)], check=True)
    git(upstream, "config", "user.name", "Native verifier")
    git(upstream, "config", "user.email", "verify@example.invalid")
    (upstream / "remote-only.txt").write_text("Pulled from the disposable local remote.\n")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-qm", "feat: remote fixture")
    git(upstream, "push", "origin", "main")
    expected = git(upstream, "rev-parse", "HEAD")
    workspace_id, thread_id = str(uuid.uuid4()), str(uuid.uuid4())
    now = int(time.time() * 1000)
    workspace = {"id": workspace_id, "root": str(repository), "label": "Source control fixture", "kind": "repository"}
    thread = {
        "id": thread_id, "workspaceId": workspace_id, "title": "Verify source control",
        "createdAtMs": now, "latestUserActivityAtMs": now,
        "nativeThreadId": None, "revision": 1, "session": {"kind": "draft"},
        "settings": {"model": "gpt-6-luna", "effort": None, "permissionMode": "full-access"},
        "checkout": {"kind": "local"}, "placement": {"kind": "kept"},
        "approvals": [], "diagnostic": None,
        "turns": [{
            "id": str(uuid.uuid4()), "prompt": "Disposable source control verification",
            "nativeTurnId": None, "delivery": {"kind": "accepted"},
            "execution": {"kind": "completed"}, "settings": None,
            "startedAtMs": now, "completedAtMs": now,
            "items": [{"kind": "assistant", "id": "seed", "text": "Use Settings and the Git control to verify the disposable repository.", "complete": True}],
        }],
    }
    with sqlite3.connect(state / "z1.sqlite") as database:
        database.executescript(
            "CREATE TABLE workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);"
            "CREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL, pr_generation INTEGER NOT NULL DEFAULT 0);"
            "CREATE TABLE receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL);"
            "CREATE TABLE ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
            "CREATE TABLE review_dispositions(workspace_id TEXT NOT NULL, pr_id TEXT NOT NULL, finding_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, pr_id, finding_id));"
            "CREATE TABLE pull_requests(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);"
            "CREATE TABLE thread_pull_requests(thread_id TEXT NOT NULL, pr_key TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id, pr_key));"
            "CREATE TABLE pull_request_operations(request_id TEXT PRIMARY KEY, pr_key TEXT NOT NULL, action_digest TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);"
            "PRAGMA user_version=3;"
        )
        database.execute("INSERT INTO workspaces VALUES(?,?,?)", (workspace_id, str(repository), json.dumps(workspace)))
        database.execute("INSERT INTO threads VALUES(?,?,?,0)", (thread_id, workspace_id, json.dumps(thread)))
        key = "github.com/fixture/project/41"
        database.execute("INSERT INTO pull_requests VALUES(?,0,?)", (key, json.dumps({"key": key, "snapshot": None, "revision": 0, "freshness": {"kind": "never_loaded"}})))
        member = {"thread": thread_id, "key": key, "generation": 0, "source": "manual", "at": now}
        database.execute("INSERT INTO thread_pull_requests VALUES(?,?,0,?,?)", (thread_id, key, "linked", json.dumps(member)))
    gh_state = root / "gh.json"
    gh_state.write_text(json.dumps({"repository": "fixture/project", "number": 41, "head": head, "baseRefOid": before, "branch": "feature/review", "outdated": False}))
    manifest = {
        "root": str(root), "dataDir": str(state), "repository": str(repository),
        "workspace": workspace_id, "thread": thread_id,
        "codex": str(peers / "codex"), "gh": str(github_peer(root)),
        "ghState": str(gh_state), "before": before, "expectedPull": expected,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def prepare_publish(root):
    prepare(root)
    manifest = json.loads((root / "manifest.json").read_text())
    repository = pathlib.Path(manifest["repository"])
    git(repository, "remote", "remove", "origin")
    remote = root / "published.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    for url in ("git@github.com:fixture/published.git", "https://github.com/fixture/published.git"):
        git(repository, "config", "--add", f"url.{remote}.insteadOf", url)
    empty = root / "empty-repository"
    empty.mkdir()
    git(empty, "init", "-q", "-b", "main")
    git(empty, "config", "user.name", "Native verifier")
    git(empty, "config", "user.email", "verify@example.invalid")
    empty_remote = root / "published-empty.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(empty_remote)], check=True)
    for url in ("git@github.com:fixture/empty.git", "https://github.com/fixture/empty.git"):
        git(empty, "config", "--add", f"url.{empty_remote}.insteadOf", url)
    git(empty, "remote", "add", "upstream", "https://github.com/fixture/unrelated.git")
    rejected = root / "rejected-repository"
    subprocess.run(["git", "clone", "-q", "--no-local", "--single-branch", "-b", "main", str(repository), str(rejected)], check=True)
    git(rejected, "remote", "remove", "origin")
    rejected_remote = root / "published-rejected.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(rejected_remote)], check=True)
    hook = rejected_remote / "hooks/pre-receive"
    hook.write_text("#!/bin/sh\nprintf 'Native fixture rejects the first publish push.\\n' >&2\nexit 1\n")
    hook.chmod(0o755)
    for url in ("git@github.com:fixture/rejected.git", "https://github.com/fixture/rejected.git"):
        git(rejected, "config", "--add", f"url.{rejected_remote}.insteadOf", url)
    empty_workspace, empty_thread = str(uuid.uuid4()), str(uuid.uuid4())
    rejected_workspace, rejected_thread = str(uuid.uuid4()), str(uuid.uuid4())
    with sqlite3.connect(pathlib.Path(manifest["dataDir"]) / "z1.sqlite") as database:
        database.execute("DELETE FROM thread_pull_requests")
        database.execute("DELETE FROM pull_requests")
        workspace = json.loads(database.execute("SELECT data FROM workspaces WHERE id=?", (manifest["workspace"],)).fetchone()[0])
        workspace["label"] = "Publish fixture"
        database.execute("UPDATE workspaces SET data=? WHERE id=?", (json.dumps(workspace), manifest["workspace"]))
        thread = json.loads(database.execute("SELECT data FROM threads WHERE id=?", (manifest["thread"],)).fetchone()[0])
        thread["title"] = "Publish repository"
        database.execute("UPDATE threads SET data=? WHERE id=?", (json.dumps(thread), manifest["thread"]))
        workspace.update(id=empty_workspace, root=str(empty), label="Empty publish fixture")
        database.execute("INSERT INTO workspaces VALUES(?,?,?)", (empty_workspace, str(empty), json.dumps(workspace)))
        thread.update(id=empty_thread, workspaceId=empty_workspace, title="Publish empty repository")
        thread["turns"][0]["id"] = str(uuid.uuid4())
        database.execute("INSERT INTO threads VALUES(?,?,?,0)", (empty_thread, empty_workspace, json.dumps(thread)))
        workspace.update(id=rejected_workspace, root=str(rejected), label="Rejected publish fixture")
        database.execute("INSERT INTO workspaces VALUES(?,?,?)", (rejected_workspace, str(rejected), json.dumps(workspace)))
        thread.update(id=rejected_thread, workspaceId=rejected_workspace, title="Publish rejected push")
        thread["turns"][0]["id"] = str(uuid.uuid4())
        database.execute("INSERT INTO threads VALUES(?,?,?,0)", (rejected_thread, rejected_workspace, json.dumps(thread)))
    (pathlib.Path(manifest["dataDir"]) / "settings.json").write_text(json.dumps({"automaticGitFetchInterval": 0, "defaultAutoPull": False}))
    gh_state = pathlib.Path(manifest["ghState"])
    state = json.loads(gh_state.read_text())
    state.update(exists=False, viewer="fixture", signedOut=True, publishDelay=3)
    gh_state.write_text(json.dumps(state))
    manifest.update(
        publishRemote=str(remote), emptyRepository=str(empty), emptyPublishRemote=str(empty_remote),
        emptyWorkspace=empty_workspace, emptyThread=empty_thread,
        rejectedRepository=str(rejected), rejectedPublishRemote=str(rejected_remote),
        rejectedWorkspace=rejected_workspace, rejectedThread=rejected_thread,
    )
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def prepare_feature(root):
    prepare(root)
    manifest = json.loads((root / "manifest.json").read_text())
    repository = pathlib.Path(manifest["repository"])
    remote = root / "remote.git"
    git(remote, "update-ref", "refs/heads/main", manifest["before"])
    git(repository, "branch", "feature/native-branch-choice")
    (repository / "README.md").write_text("Selected native feature change.\n")
    (repository / "excluded.txt").write_text("Keep this file out of the native commit.\n")
    clean = root / "clean-repository"
    subprocess.run(["git", "clone", "-q", str(remote), str(clean)], check=True)
    git(clean, "config", "user.name", "Native verifier")
    git(clean, "config", "user.email", "verify@example.invalid")
    git(clean, "remote", "set-url", "origin", "https://github.com/fixture/project.git")
    git(clean, "config", f"url.{remote}.insteadOf", "https://github.com/fixture/project.git")
    (clean / "clean-ahead.txt").write_text("Existing unpublished commit.\n")
    git(clean, "add", "-A")
    git(clean, "commit", "-qm", "Existing clean commit")
    clean_head = git(clean, "rev-parse", "HEAD")
    clean_workspace, clean_thread = str(uuid.uuid4()), str(uuid.uuid4())
    with sqlite3.connect(pathlib.Path(manifest["dataDir"]) / "z1.sqlite") as database:
        database.execute("DELETE FROM thread_pull_requests")
        database.execute("DELETE FROM pull_requests")
        workspace = json.loads(database.execute("SELECT data FROM workspaces WHERE id=?", (manifest["workspace"],)).fetchone()[0])
        workspace["label"] = "Feature branch fixture"
        database.execute("UPDATE workspaces SET data=? WHERE id=?", (json.dumps(workspace), manifest["workspace"]))
        thread = json.loads(database.execute("SELECT data FROM threads WHERE id=?", (manifest["thread"],)).fetchone()[0])
        thread["title"] = "Continue on feature branch"
        database.execute("UPDATE threads SET data=? WHERE id=?", (json.dumps(thread), manifest["thread"]))
        workspace.update(id=clean_workspace, root=str(clean), label="Clean default fixture")
        database.execute("INSERT INTO workspaces VALUES(?,?,?)", (clean_workspace, str(clean), json.dumps(workspace)))
        thread.update(id=clean_thread, workspaceId=clean_workspace, title="Refuse clean feature choice")
        thread["turns"][0]["id"] = str(uuid.uuid4())
        database.execute("INSERT INTO threads VALUES(?,?,?,0)", (clean_thread, clean_workspace, json.dumps(thread)))
    (pathlib.Path(manifest["dataDir"]) / "settings.json").write_text(json.dumps({"automaticGitFetchInterval": 0, "defaultAutoPull": False}))
    state_path = pathlib.Path(manifest["ghState"])
    state = json.loads(state_path.read_text())
    state.update(exists=False, viewer="fixture", signedOut=False, branch="feature/native-branch-choice-2", base="main", createDelay=2, captureGitAtCreate=True)
    state_path.write_text(json.dumps(state))
    manifest.update(featureRemote=str(remote), cleanRepository=str(clean), cleanWorkspace=clean_workspace, cleanThread=clean_thread, cleanHead=clean_head)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def check(root, scenario):
    manifest = json.loads((root / "manifest.json").read_text())
    repository = pathlib.Path(manifest["repository"])
    settings = json.loads((pathlib.Path(manifest["dataDir"]) / "settings.json").read_text())
    if scenario == "fetch":
        assert git(repository, "rev-parse", "HEAD") == manifest["before"]
        assert git(repository, "rev-parse", "origin/main") == manifest["expectedPull"]
        assert settings["defaultAutoPull"] is False
    elif scenario == "auto-pull":
        assert git(repository, "rev-parse", "HEAD") == manifest["expectedPull"]
        assert (repository / "remote-only.txt").read_text() == "Pulled from the disposable local remote.\n"
        assert git(repository, "status", "--porcelain") == ""
    elif scenario == "custom-preview":
        entries = [json.loads(line) for line in (root / "peers/commit.jsonl").read_text().splitlines()]
        assert any("NATIVE_CUSTOM_INSTRUCTIONS" in entry["prompt"] for entry in entries)
        assert git(repository, "diff", "--cached", "--name-only") == ""
    elif scenario == "template-pr":
        entries = [json.loads(line) for line in (root / "peers/pr.jsonl").read_text().splitlines()]
        assert any("NATIVE_TEMPLATE" in entry["prompt"] for entry in entries)
        calls = [json.loads(line) for line in (root / "gh-calls.jsonl").read_text().splitlines()]
        assert any(call["args"][:2] == ["pr", "create"] and "## Fixture template" in call.get("body", "") for call in calls)
    elif scenario == "settings":
        assert settings["automaticGitFetchInterval"] == 0
        assert settings["defaultAutoPull"] is True
        assert settings["pullRequestMergeMethod"] == "rebase"
        assert settings["sourceControlWritingStyle"] == {
            "mode": "custom",
            "customInstructions": "NATIVE_CUSTOM_INSTRUCTIONS",
            "followChangeRequestTemplates": False,
        }
        assert settings["projectOverrides"][manifest["workspace"]]["defaultAutoPull"] is False
    elif scenario == "github-readiness":
        calls = [json.loads(line) for line in (root / "gh-calls.jsonl").read_text().splitlines()]
        auth = [call for call in calls if call["args"][:2] == ["auth", "status"]]
        assert auth and all(call["host"] == "github.com" and "github.com" in call["args"] for call in auth)
        assert not any(call["args"][:2] == ["repo", "create"] for call in calls)
        assert git(repository, "remote") == ""
    elif scenario == "feature-abort":
        assert git(repository, "branch", "--show-current") == "main"
        assert git(repository, "rev-parse", "HEAD") == manifest["before"]
        assert git(repository, "diff", "--cached", "--name-only") == ""
        assert git(repository, "status", "--porcelain") == "M README.md\n?? excluded.txt"
        assert git(pathlib.Path(manifest["featureRemote"]), "rev-parse", "main") == manifest["before"]
    elif scenario == "feature-branch":
        branch = "feature/native-branch-choice-2"
        head = git(repository, "rev-parse", "HEAD")
        assert git(repository, "branch", "--show-current") == branch
        assert git(repository, "log", "-1", "--format=%B") == "Native branch choice"
        assert git(repository, "show", "--format=", "--name-only", "HEAD") == "README.md"
        assert git(repository, "rev-parse", "main") == manifest["before"]
        assert git(repository, "rev-parse", "@{upstream}") == head
        assert git(pathlib.Path(manifest["featureRemote"]), "rev-parse", branch) == head
        assert git(repository, "config", f"branch.{branch}.gh-merge-base") == "main"
        assert (repository / "excluded.txt").read_text() == "Keep this file out of the native commit.\n"
        assert git(repository, "diff", "--cached", "--name-only") == ""
    elif scenario == "feature-pr":
        branch = "feature/native-branch-choice-2"
        calls = [json.loads(line) for line in (root / "gh-calls.jsonl").read_text().splitlines()]
        create = [call for call in calls if call["args"][:2] == ["pr", "create"]]
        assert len(create) == 1
        args = create[0]["args"]
        assert args[args.index("--head") + 1] == branch
        assert args[args.index("--base") + 1] == "main"
        assert git(repository, "branch", "--show-current") == branch
    elif scenario == "feature-refusal":
        repository = pathlib.Path(manifest["cleanRepository"])
        assert git(repository, "branch", "--show-current") == "main"
        assert git(repository, "rev-parse", "HEAD") == manifest["cleanHead"]
        assert git(repository, "status", "--porcelain") == ""
        assert git(pathlib.Path(manifest["featureRemote"]), "rev-parse", "main") == manifest["before"]
        assert git(repository, "for-each-ref", "--format=%(refname)", "refs/heads/") == "refs/heads/main"
    elif scenario in ("publish", "publish-empty", "publish-rejected"):
        calls = [json.loads(line) for line in (root / "gh-calls.jsonl").read_text().splitlines()]
        slug = {"publish": "fixture/published", "publish-empty": "fixture/empty", "publish-rejected": "fixture/rejected"}[scenario]
        create = [call for call in calls if call["args"][:3] == ["repo", "create", slug]]
        assert len(create) == 1
        assert create[0]["host"] == "github.com"
        if scenario == "publish":
            assert "--private" in create[0]["args"]
            assert git(repository, "config", "--get", "remote.origin.url") == "git@github.com:fixture/published.git"
            assert git(repository, "rev-parse", "HEAD") == manifest["before"]
            assert git(repository, "rev-parse", "@{upstream}") == manifest["before"]
            assert git(pathlib.Path(manifest["publishRemote"]), "rev-parse", "main") == manifest["before"]
        elif scenario == "publish-empty":
            repository = pathlib.Path(manifest["emptyRepository"])
            assert "--public" in create[0]["args"]
            assert git(repository, "config", "--get", "remote.upstream.url") == "https://github.com/fixture/unrelated.git"
            assert git(repository, "config", "--get", "remote.upstream-1.url") == "https://github.com/fixture/empty.git"
            assert git(repository, "for-each-ref", "--format=%(refname)") == ""
            assert git(pathlib.Path(manifest["emptyPublishRemote"]), "for-each-ref", "--format=%(refname)") == ""
        else:
            repository = pathlib.Path(manifest["rejectedRepository"])
            assert "--private" in create[0]["args"]
            assert git(repository, "config", "--get", "remote.origin.url") == "git@github.com:fixture/rejected.git"
            assert git(repository, "rev-parse", "HEAD") == manifest["before"]
            assert git(pathlib.Path(manifest["rejectedPublishRemote"]), "for-each-ref", "--format=%(refname)") == ""
    head = subprocess.run(["git", "-C", str(repository), "rev-parse", "--verify", "HEAD"], capture_output=True, text=True)
    result = {"scenario": scenario, "result": "passed", "head": head.stdout.strip() if head.returncode == 0 else None}
    (root / f"{scenario}-check.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


def launch(root, app):
    import os

    manifest = json.loads((root / "manifest.json").read_text())
    manifest["gh"] = str(github_peer(root))
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    environment = dict(
        os.environ,
        BOT_CODE_DATA_DIR=manifest["dataDir"],
        BOT_CODE_CODEX_BIN=manifest["codex"],
        BOT_CODE_GH_BIN=manifest["gh"],
        BOT_CODE_PR_FIXTURE_STATE=manifest["ghState"],
    )
    if "publishRemote" in manifest:
        environment["GH_HOST"] = "enterprise.invalid"
    process = subprocess.Popen(
        [str(app.resolve() / "Contents/MacOS/bot-code")],
        env=environment,
        stdout=(root / "app.log").open("a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    (root / "app.pid").write_text(str(process.pid))
    print(json.dumps({"pid": process.pid, "dataDir": manifest["dataDir"]}))


parser = argparse.ArgumentParser(description="Prepare isolated source control fixtures and check actual native results.")
commands = parser.add_subparsers(dest="command", required=True)
for name in ("prepare", "prepare-publish", "prepare-feature", "check", "launch"):
    command = commands.add_parser(name)
    command.add_argument("root", type=pathlib.Path)
    if name == "check":
        command.add_argument("scenario", choices=("settings", "fetch", "auto-pull", "custom-preview", "template-pr", "github-readiness", "publish", "publish-empty", "publish-rejected", "feature-abort", "feature-branch", "feature-pr", "feature-refusal"))
    elif name == "launch":
        command.add_argument("app", type=pathlib.Path)
args = parser.parse_args()
if args.command == "prepare":
    prepare(args.root.resolve())
elif args.command == "prepare-publish":
    prepare_publish(args.root.resolve())
elif args.command == "prepare-feature":
    prepare_feature(args.root.resolve())
elif args.command == "check":
    check(args.root.resolve(), args.scenario)
else:
    launch(args.root.resolve(), args.app)
