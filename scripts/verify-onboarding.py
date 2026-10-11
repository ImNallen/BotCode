#!/usr/bin/env python3
import argparse
import json
import pathlib
import sqlite3
import subprocess
import uuid


def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    for name in ("data", "codex-home", "peers", "repository"):
        (root / name).mkdir()
    repository = root / "repository"
    subprocess.run(["git", "init", "-q", "-b", "main", str(repository)], check=True)
    (repository / "README.md").write_text("Disposable onboarding repository.\n")
    subprocess.run(["git", "-C", str(repository), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(repository), "-c", "user.name=Verifier", "-c", "user.email=verify@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "Initial fixture"], check=True)
    (root / "readiness").write_text("ready")
    peer = root / "peers/codex"
    peer.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(__file__).resolve().parents[1]
def log(value):
    with (root / "codex-calls.jsonl").open("a") as stream:
        stream.write(json.dumps(value) + "\\n")
log({"argv": sys.argv[1:]})
state = (root / "readiness").read_text().strip()
if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.160.1"); sys.exit(0)
if sys.argv[1:] == ["login", "status"]:
    print("Logged in using ChatGPT" if state == "ready" else "Not logged in", file=sys.stderr)
    sys.exit(0 if state == "ready" else 1)
if sys.argv[1:] == ["login"]:
    (root / "readiness").write_text("ready"); print("Successfully logged in"); sys.exit(0)
for line in sys.stdin:
    request = json.loads(line)
    log(request)
    if "id" not in request: continue
    method = request.get("method")
    if method == "initialize": result = {"userAgent": "fixture"}
    elif method == "account/read":
        result = {"account": {"type": "chatgpt", "planType": "plus"} if state == "ready" else None, "requiresOpenaiAuth": True}
    elif method == "model/list":
        result = {"data": [{"id": "gpt-6-luna", "model": "gpt-6-luna", "displayName": "GPT-6-Luna", "description": "Fixture", "hidden": False, "isDefault": True, "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": "Medium"}], "defaultReasoningEffort": "medium", "inputModalities": ["text"], "supportsPersonality": False}], "nextCursor": None}
    elif method == "collaborationMode/list": result = {"data": []}
    elif method == "account/rateLimits/read": result = {"rateLimits": {"planType": "plus", "primary": {"usedPercent": 0, "windowDurationMins": 300}}}
    elif method == "thread/resume": result = {"thread": {"id": request["params"]["threadId"], "turns": []}}
    else:
        print(json.dumps({"id": request["id"], "error": {"code": -32601, "message": "Unsupported fixture method"}}), flush=True)
        continue
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
''')
    peer.chmod(0o755)
    print(json.dumps({"root": str(root), "data": str(root / "data"), "codexHome": str(root / "codex-home"), "codex": str(peer), "repository": str(repository)}))


def check(root):
    with sqlite3.connect(f"file:{root / 'data/z1.sqlite'}?mode=ro", uri=True) as database:
        state = dict(database.execute("SELECT key, value FROM ui_state"))
        projects = [json.loads(row[0]) for row in database.execute("SELECT data FROM workspaces")]
        threads = [json.loads(row[0]) for row in database.execute("SELECT data FROM threads")]
    calls = [json.loads(line) for line in (root / "codex-calls.jsonl").read_text().splitlines()] if (root / "codex-calls.jsonl").exists() else []
    print(json.dumps({"uiState": state, "projects": projects, "threads": threads, "codexCalls": calls}, indent=2))


def seed_legacy(root):
    repository = root / "repository"
    workspace = {"id": str(uuid.uuid4()), "root": str(repository), "label": "Legacy onboarding fixture", "kind": "repository", "faviconPath": None, "projectIcon": None}
    with sqlite3.connect(root / "data/z1.sqlite") as database:
        database.execute("INSERT INTO workspaces(id, root, data) VALUES (?, ?, ?)", (workspace["id"], workspace["root"], json.dumps(workspace)))
    print(workspace["id"])


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["prepare", "check", "seed-legacy"])
parser.add_argument("root", type=pathlib.Path)
arguments = parser.parse_args()
{"prepare": prepare, "check": check, "seed-legacy": seed_legacy}[arguments.action](arguments.root.resolve())
