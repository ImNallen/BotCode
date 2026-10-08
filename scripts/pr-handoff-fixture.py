#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description='Prepare isolated native PR handoff verification.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path, help='Launch this built Tauri .app after preparation.')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
fixture = args.directory.resolve()
fixture.mkdir(parents=True)
repo = fixture / 'repo'
repo.mkdir()


def git(*arguments):
    return subprocess.check_output(['git', '-C', str(repo), *arguments], stderr=subprocess.STDOUT).decode().strip()


git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.invalid')
(repo / 'README.md').write_text('Disposable PR handoff repository.\n')
setup_log = str(fixture / 'setup.log').replace("'", "'\\''")
(repo / 't3.json').write_text(json.dumps({
    'worktreeSubmodules': 'none',
    'scripts': [{
        'name': 'Install dependencies',
        'command': f"printf 'SETUP_FOR_PR\\n'; printf '%s\\n' \"$PWD\" >> '{setup_log}'; sleep 2; printf 'SETUP_COMPLETE\\n'",
        'runOnWorktreeCreate': True,
        'async': False,
    }],
}))
git('add', '.')
git('commit', '-qm', 'Fixture main')
main = git('rev-parse', 'HEAD')
git('checkout', '-qb', 'feature')
(repo / 'calculate.ts').write_text('export const calculate = (n: number) => n + 1;\n')
git('add', '.')
git('commit', '-qm', 'PR head')
head = git('rev-parse', 'HEAD')
git('checkout', 'main')
remote = fixture / 'remote.git'
subprocess.run(['git', 'clone', '-q', '--bare', str(repo), str(remote)], check=True)
subprocess.run(['git', '--git-dir', str(remote), 'update-ref', 'refs/pull/41/head', head], check=True)
git('remote', 'add', 'origin', 'https://github.com/fixture/project.git')
git('config', f'url.{remote}.insteadOf', 'https://github.com/fixture/project.git')
existing = fixture / 'existing'
git('worktree', 'add', '-qb', 'existing', str(existing), 'main')
detached = fixture / 'detached'
git('worktree', 'add', '--detach', str(detached), 'main')
missing = fixture / 'missing'
git('worktree', 'add', '-qb', 'missing', str(missing), 'main')
shutil.rmtree(missing)
provider = fixture / 'provider'
provider.mkdir()
shutil.copyfile(root / 'crates/bot-core/tests/support/codex_peer.py', provider / 'codex')
(provider / 'codex').chmod(0o755)
state = fixture / 'gh.json'
state.write_text(json.dumps({'repository': 'fixture/project', 'number': 41, 'head': head, 'branch': 'feature', 'outdated': False}))
data = fixture / 'data'
data.mkdir()
workspace_id, source_id, existing_id = [str(uuid.uuid4()) for _ in range(3)]
workspace = {'id': workspace_id, 'root': str(repo), 'label': 'PR handoff fixture', 'kind': 'repository'}
now = int(time.time() * 1000)
with sqlite3.connect(data / 'z1.sqlite') as db:
    db.executescript('''
        CREATE TABLE workspaces(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL, pr_generation INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE receipts(request_id TEXT PRIMARY KEY, input TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE review_dispositions(workspace_id TEXT NOT NULL, pr_id TEXT NOT NULL, finding_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, pr_id, finding_id));
        CREATE TABLE pull_requests(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE thread_pull_requests(thread_id TEXT NOT NULL, pr_key TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread_id, pr_key));
        CREATE TABLE pull_request_operations(request_id TEXT PRIMARY KEY, pr_key TEXT NOT NULL, action_digest TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
        PRAGMA user_version=3;
    ''')
    db.execute('INSERT INTO workspaces VALUES(?,?,?)', (workspace_id, str(repo), json.dumps(workspace)))
    for thread_id, title, checkout, text in [
        (source_id, 'Source conversation', {'kind': 'local'}, 'SOURCE_UNSENT'),
        (existing_id, 'Existing worktree conversation', {'kind': 'worktree', 'path': str(existing), 'branch': 'existing'}, 'DESTINATION_UNSENT'),
    ]:
        thread = {'id': thread_id, 'workspaceId': workspace_id, 'title': title, 'nativeThreadId': None, 'revision': 1,
                  'session': {'kind': 'draft'}, 'checkout': checkout, 'turns': [], 'approvals': [], 'diagnostic': None, 'createdAtMs': now}
        db.execute('INSERT INTO threads VALUES(?,?,?,0)', (thread_id, workspace_id, json.dumps(thread)))
        draft = {'version': 2, 'text': text, 'records': [], 'attachments': []}
        db.execute('INSERT INTO ui_state VALUES(?,?)', ('composer-draft:' + thread_id, json.dumps(draft)))
    key = 'github.com/fixture/project/41'
    pr = {'key': key, 'snapshot': None, 'revision': 0, 'freshness': {'kind': 'never_loaded'}}
    db.execute('INSERT INTO pull_requests VALUES(?,0,?)', (key, json.dumps(pr)))
    member = {'thread': source_id, 'key': key, 'generation': 0, 'source': 'manual', 'at': now}
    db.execute('INSERT INTO thread_pull_requests VALUES(?,?,0,?,?)', (source_id, key, 'linked', json.dumps(member)))
manifest = {'workspace': workspace, 'sourceThreadId': source_id, 'existingThreadId': existing_id,
            'main': main, 'head': head, 'existing': str(existing), 'detached': str(detached), 'missing': str(missing)}
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
if args.app:
    app = args.app.resolve()
    environment = dict(os.environ, BOT_CODE_DATA_DIR=str(data), BOT_CODE_GH_BIN=str(root / 'crates/bot-core/tests/fixtures/gh-lifecycle.py'),
                       BOT_CODE_PR_FIXTURE_STATE=str(state), BOT_CODE_CODEX_BIN=str(provider / 'codex'))
    process = subprocess.Popen([str(app / 'Contents/MacOS/bot-code')], env=environment,
                               stdout=(fixture / 'app.log').open('w'), stderr=subprocess.STDOUT, start_new_session=True)
    (fixture / 'app.pid').write_text(str(process.pid))
    manifest['pid'] = process.pid
print(json.dumps(manifest, indent=2))
