#!/usr/bin/env python3
import argparse
import json
import pathlib
import sqlite3
import subprocess


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    for name in ("data", "peers", "remotes"):
        (root / name).mkdir()
    config = root / "gitconfig"
    config.write_text('[user]\n name = Native verifier\n email = verify@example.invalid\n[init]\n defaultBranch = main\n[commit]\n gpgSign = false\n')
    peer = root / "peers/gh"
    peer.write_text(
        "#!/usr/bin/env python3\n"
        "import json, pathlib, subprocess, sys\n"
        "root = pathlib.Path(__file__).resolve().parents[1]\n"
        "args = sys.argv[1:]\n"
        "with (root / 'github-calls.jsonl').open('a') as f: f.write(json.dumps(args) + '\\n')\n"
        "if args[:2] == ['auth', 'status']: sys.exit(0)\n"
        "if args[:1] == ['api']: print('fixture'); sys.exit(0)\n"
        "if args[:2] == ['repo', 'create']:\n"
        "    assert '--private' in args, args\n"
        "    repository = args[2]\n"
        "    bare = root / 'remotes' / (repository.split('/')[-1] + '.git')\n"
        "    subprocess.run(['git', 'init', '-q', '--bare', str(bare)], check=True)\n"
        "    subprocess.run(['git', 'config', 'url.' + str(bare) + '.insteadOf', 'git@github.com:' + repository + '.git'], check=True)\n"
        "    print('https://github.com/' + repository); sys.exit(0)\n"
        "print('Unsupported fixture GitHub request', file=sys.stderr); sys.exit(1)\n"
    )
    peer.chmod(0o755)
    source = root / "clone-source"
    source.mkdir()
    git(source, "init", "-q", "-b", "main")
    git(source, "config", "user.name", "Native verifier")
    git(source, "config", "user.email", "verify@example.invalid")
    (source / "README.md").write_text("Disposable clone fixture.\n")
    git(source, "add", "README.md")
    git(source, "-c", "commit.gpgSign=false", "commit", "-qm", "Initial fixture")
    print(json.dumps({"root": str(root), "data": str(root / "data"), "github": str(peer), "gitConfig": str(config), "cloneUrl": source.as_uri()}))


def check_new(root):
    data = root / "data"
    with sqlite3.connect(data / "z1.sqlite") as db:
        projects = [json.loads(row[0]) for row in db.execute("SELECT data FROM workspaces")]
    created = [p for p in projects if p["label"] == "Native Pinball Stats"]
    assert created, projects
    for project in created:
        repository = pathlib.Path(project["root"])
        assert repository.parent == data / "projects", repository
        assert (repository / "assets/icon.svg").is_file()
        assert "# Native Pinball Stats" in (repository / "README.md").read_text()
        assert git(repository, "log", "-1", "--format=%s") == "Initial commit"
        assert not git(repository, "status", "--porcelain")
    names = {pathlib.Path(p["root"]).name for p in created}
    assert "native-pinball-stats" in names
    assert "native-pinball-stats-2" in names, names
    calls = [json.loads(line) for line in (root / "github-calls.jsonl").read_text().splitlines()]
    publishes = [args for args in calls if args[:2] == ["repo", "create"]]
    assert len(publishes) == 1 and "--private" in publishes[0], publishes
    private = next(p for p in created if pathlib.Path(p["root"]).name == "native-pinball-stats-2")
    repository = pathlib.Path(private["root"])
    assert git(repository, "config", "remote.origin.url") == "git@github.com:fixture/native-pinball-stats-2.git"
    assert git(repository, "rev-parse", "HEAD") == git(root / "remotes/native-pinball-stats-2.git", "rev-parse", "main")
    print("VERIFIED new project, collision suffix, starter files, initial commits, private publication and local push")


def check_clone(root, cancelled):
    repository = root / "native-clone"
    with sqlite3.connect(root / "data/z1.sqlite") as db:
        projects = [json.loads(row[0]) for row in db.execute("SELECT data FROM workspaces")]
        matches = [project for project in projects if project["root"] == str(repository)]
        assert len(matches) == 1, matches
        assert db.execute("SELECT COUNT(*) FROM threads WHERE workspace_id = ?", (matches[0]["id"],)).fetchone()[0] == 0
    if cancelled:
        assert repository.is_dir() and not list(repository.iterdir()), list(repository.iterdir())
        processes = subprocess.check_output(["ps", "-axo", "comm,args"], text=True).splitlines()
        assert not any(line.split()[0].endswith("git") and "clone --progress" in line and "native-clone" in line for line in processes)
        print("VERIFIED cancelled clone keeps project, removes partial checkout, stops Git and creates no thread")
    else:
        assert git(repository, "rev-parse", "HEAD") == git(root / "clone-source", "rev-parse", "HEAD")
        assert (repository / "payload.bin").read_bytes() == (root / "clone-source/payload.bin").read_bytes()
        assert not git(repository, "status", "--porcelain")
        print("VERIFIED clone retry completes with exact source HEAD and files, clean checkout and no accidental thread")


def check_worktrees(root):
    keep = json.loads((root / "worktree-keep.json").read_text())
    remove = json.loads((root / "worktree-delete.json").read_text())
    with sqlite3.connect(root / "data/z1.sqlite") as db:
        for thread in (keep, remove):
            assert db.execute("SELECT COUNT(*) FROM threads WHERE id = ?", (thread["id"],)).fetchone()[0] == 0
            workspace = json.loads(db.execute("SELECT data FROM workspaces WHERE id = ?", (thread["workspaceId"],)).fetchone()[0])
            assert git(pathlib.Path(workspace["root"]), "show-ref", "--verify", "refs/heads/" + thread["checkout"]["branch"])
    kept = pathlib.Path(keep["checkout"]["path"])
    removed = pathlib.Path(remove["checkout"]["path"])
    assert (kept / "manual-notes.txt").read_text().startswith("disposable")
    assert not removed.exists(), removed
    print("VERIFIED native Keep preserves dirty worktree, Delete removes dirty worktree, both delete threads and retain branches")


def check_actions(root):
    settings = json.loads((root / "data/settings.json").read_text())
    project = json.loads((root / "action-reset-project.json").read_text())
    assert settings["projectSettingsFolded"] is True
    assert settings["defaultProjectScripts"][0]["id"] == "machine-action"
    assert "defaultProjectScripts" not in settings.get("projectSettingsOverrides", {}).get(project["id"], {})
    assert project["id"] not in settings.get("projectScriptOverrides", {})
    assert (pathlib.Path(project["root"]) / "t3.json").read_bytes() == (root / "action-t3-original.txt").read_bytes()
    assert (root / "action-marker").read_text() == "native-action"
    assert (root / "machine-marker").read_text() == "machine-default"
    print("VERIFIED native action execution, folded settings, reset to machine defaults, mirrored legacy reset and unchanged t3.json")


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["prepare", "check-new", "check-clone-cancel", "check-clone", "check-worktrees", "check-actions"])
parser.add_argument("root", type=pathlib.Path)
args = parser.parse_args()
args.root = args.root.resolve()
if args.action == "prepare":
    prepare(args.root)
elif args.action == "check-new":
    check_new(args.root)
elif args.action == "check-actions":
    check_actions(args.root)
elif args.action == "check-worktrees":
    check_worktrees(args.root)
else:
    check_clone(args.root, args.action == "check-clone-cancel")
