#!/usr/bin/env python3
import argparse
import json
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import time
import uuid


def git(repository, *arguments):
    return subprocess.check_output(
        ["git", "-C", str(repository), *arguments],
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()


def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    state = root / "state"
    state.mkdir()
    peers = root / "peers"
    peers.mkdir()
    source = pathlib.Path(__file__).resolve().parents[1]
    shutil.copy(source / "crates/bot-core/tests/support/codex_peer.py", peers / "codex")
    (peers / "codex").chmod(0o755)
    (peers / "commit_output").write_text(
        json.dumps({"subject": "Commit selected files", "body": ""})
    )
    database = sqlite3.connect(state / "z1.sqlite")
    database.executescript(
        "CREATE TABLE workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);"
        "CREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL);"
        "CREATE TABLE receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL);"
        "CREATE TABLE ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        "PRAGMA user_version=1;"
    )
    cases = {}
    for scenario in ("selection", "hooks", "partial"):
        repository = root / scenario
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        git(repository, "config", "user.name", "Native verifier")
        git(repository, "config", "user.email", "verify@example.invalid")
        tracked = (
            ("staged.txt", "mixed.txt", "unstaged.txt", "exclude-staged.txt",
             "exclude-unstaged.txt", "deleted.txt", "old name.txt")
            if scenario == "selection" else ("changed.txt",)
        )
        for name in tracked:
            (repository / name).write_text("base\n")
        git(repository, "add", "-A")
        git(repository, "commit", "-qm", "Baseline")
        before = git(repository, "rev-parse", "HEAD")
        if scenario == "selection":
            for name in ("staged.txt", "mixed.txt", "exclude-staged.txt"):
                (repository / name).write_text("staged\n")
            git(repository, "add", "--", "staged.txt", "mixed.txt", "exclude-staged.txt")
            (repository / "mixed.txt").write_text("current unstaged content\n")
            for name in ("unstaged.txt", "untracked.txt", "exclude-unstaged.txt", "exclude-untracked.txt"):
                (repository / name).write_text(name + " changed\n")
            (repository / "deleted.txt").unlink()
            git(repository, "mv", "old name.txt", "new name.txt")
            git(repository, "branch", "feature/select-files")
        else:
            (repository / "changed.txt").write_text("changed\n")
        if scenario == "hooks":
            control = root / "hook-control"
            control.mkdir()
            script = (
                "#!/bin/sh\n"
                "printf 'native hook started\\n'\n"
                f"touch '{control}/started'\n"
                "attempt=0\n"
                f"while [ ! -f '{control}/release' ] && [ $attempt -lt 90 ]; do\n"
                "  printf 'checking selected files\\r' >&2\n"
                "  sleep 1\n"
                "  attempt=$((attempt + 1))\n"
                "done\n"
                f"if [ -f '{control}/fail' ]; then\n"
                "  printf 'native hook rejected commit\\n' >&2\n"
                "  exit 1\n"
                "fi\n"
                "printf 'native hook passed\\n'\n"
            )
            hook = repository / ".git/hooks/pre-commit"
            hook.write_text(script)
            hook.chmod(0o755)
        if scenario == "partial":
            git(repository, "switch", "-qc", "feature/partial")
            git(repository, "config", "branch.feature/partial.gh-merge-base", "main")
            git(repository, "remote", "add", "origin", str(root / "missing-origin.git"))
        workspace_id, thread_id = str(uuid.uuid4()), str(uuid.uuid4())
        now = int(time.time() * 1000)
        workspace = {"id": workspace_id, "root": str(repository), "label": scenario.title(), "kind": "repository"}
        thread = {
            "id": thread_id, "workspaceId": workspace_id, "title": "Verify " + scenario,
            "createdAtMs": now, "latestUserActivityAtMs": now,
            "nativeThreadId": None, "revision": 1, "session": {"kind": "draft"},
            "settings": {"model": "gpt-6-luna", "effort": None, "permissionMode": "full-access"},
            "checkout": {"kind": "local"}, "placement": {"kind": "kept"},
            "approvals": [], "diagnostic": None,
            "turns": [{
                "id": str(uuid.uuid4()), "prompt": "Disposable Git verification",
                "nativeTurnId": None, "delivery": {"kind": "accepted"},
                "execution": {"kind": "completed"}, "settings": None,
                "startedAtMs": now, "completedAtMs": now,
                "items": [{"kind": "assistant", "id": "seed", "text": "Use the Git control to verify this disposable repository.", "complete": True}],
            }],
        }
        database.execute("INSERT INTO workspaces VALUES(?,?,?)", (workspace_id, str(repository), json.dumps(workspace)))
        database.execute("INSERT INTO threads VALUES(?,?,?)", (thread_id, workspace_id, json.dumps(thread)))
        cases[scenario] = {"repository": str(repository), "workspace": workspace_id, "thread": thread_id, "before": before}
    database.commit()
    database.close()
    manifest = {"root": str(root), "dataDir": str(state), "codex": str(peers / "codex"), "gh": str(peers / "missing-gh"), "cases": cases}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def check(root, scenario):
    manifest = json.loads((root / "manifest.json").read_text())
    case = manifest["cases"]["hooks" if scenario == "hooks-success" else scenario]
    repository = pathlib.Path(case["repository"])
    head = git(repository, "rev-parse", "HEAD")
    branch = git(repository, "branch", "--show-current")
    if scenario == "selection":
        assert branch == "feature/select-files-2", branch
        assert git(repository, "rev-parse", "feature/select-files") == case["before"]
        changed = set(git(repository, "diff", "--no-renames", "--name-only", case["before"], head).splitlines())
        expected = {"staged.txt", "mixed.txt", "unstaged.txt", "untracked.txt", "deleted.txt", "old name.txt", "new name.txt"}
        assert changed == expected, (changed, expected)
        assert git(repository, "show", "HEAD:mixed.txt") == "current unstaged content"
        assert git(repository, "show", "HEAD:exclude-staged.txt") == "base"
        assert git(repository, "show", "HEAD:exclude-unstaged.txt") == "base"
        assert "exclude-untracked.txt" not in git(repository, "ls-tree", "-r", "--name-only", "HEAD").splitlines()
        assert git(repository, "diff", "--cached", "--name-only") == ""
        assert (repository / "exclude-staged.txt").read_text() == "staged\n"
        assert (repository / "exclude-unstaged.txt").read_text() == "exclude-unstaged.txt changed\n"
        assert (repository / "exclude-untracked.txt").read_text() == "exclude-untracked.txt changed\n"
    elif scenario == "hooks":
        assert head == case["before"], "A rejected hook created a commit"
        assert branch == "feature/hook-rejected", branch
        assert git(repository, "diff", "--cached", "--name-only") == "changed.txt"
    elif scenario == "hooks-success":
        assert head != case["before"], "The successful hook did not commit"
        assert git(repository, "show", "HEAD:changed.txt") == "changed"
    elif scenario == "partial":
        assert head != case["before"], "The completed commit was lost after push failure"
        assert branch == "feature/partial"
        assert git(repository, "show", "HEAD:changed.txt") == "changed"
        assert not (root / "missing-origin.git").exists()
    print(json.dumps({"scenario": scenario, "branch": branch, "head": head, "result": "VERIFIED"}, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Prepare isolated native fixtures and check their actual Git results."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("root", type=pathlib.Path, nargs="?")
    check_parser = commands.add_parser("check")
    check_parser.add_argument("root", type=pathlib.Path)
    check_parser.add_argument("scenario", choices=("selection", "hooks", "hooks-success", "partial"))
    args = parser.parse_args()
    if args.command == "prepare":
        root = args.root or pathlib.Path(tempfile.mkdtemp(prefix="bot-commit-native-")) / "fixtures"
        prepare(root.resolve())
    else:
        check(args.root.resolve(), args.scenario)


if __name__ == "__main__":
    main()
