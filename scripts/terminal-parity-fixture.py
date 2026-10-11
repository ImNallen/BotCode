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

parser = argparse.ArgumentParser(description='Prepare or relaunch isolated native terminal and Open in verification.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path, help='Launch this built Tauri .app with the fixture data directory.')
parser.add_argument('--relaunch', action='store_true', help='Reuse an existing fixture instead of creating one.')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
fixture = args.directory.resolve()
data = fixture / 'data'
provider = fixture / 'provider'


def create_repository(name, files):
    repo = fixture / name
    repo.mkdir()
    for relative, text in files.items():
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        (repo / relative).write_text(text)
    for command in (['init', '-q', '-b', 'main'], ['add', '.']):
        subprocess.check_call(['git', '-C', str(repo), *command])
    subprocess.check_call(['git', '-C', str(repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                           '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture main'])
    return repo


def prepare():
    fixture.mkdir(parents=True)
    alpha = create_repository('alpha', {
        'README.md': 'Disposable terminal parity repository.\n',
        'src/app.ts': 'export const answer = 42;\n',
        'site/index.html': '<!doctype html><title>Terminal link fixture</title><h1>Terminal link fixture</h1>\n',
    })
    beta = create_repository('beta', {'README.md': 'Second disposable repository.\n'})
    provider.mkdir()
    shutil.copyfile(root / 'crates/bot-core/tests/support/codex_peer.py', provider / 'codex')
    (provider / 'codex').chmod(0o755)
    data.mkdir()
    now = int(time.time() * 1000)
    minute = 60_000
    workspaces = []
    threads = {}
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
        for label, repo, titles in (('Terminal alpha', alpha, ['Alpha one', 'Alpha two', 'Alpha three']),
                                    ('Terminal beta', beta, ['Beta one'])):
            workspace = {'id': str(uuid.uuid4()), 'root': str(repo), 'label': label, 'kind': 'repository'}
            workspaces.append(workspace)
            db.execute('INSERT INTO workspaces VALUES(?,?,?)', (workspace['id'], str(repo), json.dumps(workspace)))
            for index, title in enumerate(titles):
                thread_id = str(uuid.uuid4())
                threads[title] = thread_id
                ago = (len(titles) - index) * minute
                turn = {'id': str(uuid.uuid4()), 'prompt': f'Fixture prompt for {title}', 'nativeTurnId': None,
                        'delivery': {'kind': 'accepted'}, 'execution': {'kind': 'completed'},
                        'items': [{'kind': 'assistant', 'id': str(uuid.uuid4()), 'complete': True,
                                   'text': 'Open the [fixture site](http://127.0.0.1:8765/) or '
                                           '[email the fixture](mailto:fixture@example.invalid).'}],
                        'startedAtMs': now - ago - minute, 'completedAtMs': now - ago}
                thread = {'id': thread_id, 'workspaceId': workspace['id'], 'title': title, 'nativeThreadId': None,
                          'revision': 1, 'session': {'kind': 'dormant'}, 'checkout': {'kind': 'local'}, 'turns': [turn],
                          'approvals': [], 'diagnostic': None, 'createdAtMs': now - ago - 5 * minute,
                          'placement': {'kind': 'auto'}, 'snooze': None}
                db.execute('INSERT INTO threads VALUES(?,?,?,0)', (thread_id, workspace['id'], json.dumps(thread)))
    return {'workspaces': workspaces, 'threads': threads, 'data': str(data), 'provider': str(provider / 'codex')}


manifest = json.loads((fixture / 'manifest.json').read_text()) if args.relaunch else prepare()
if args.app:
    app = args.app.resolve()
    environment = dict(os.environ, BOT_CODE_DATA_DIR=str(data), BOT_CODE_CODEX_BIN=str(provider / 'codex'))
    binary = next((app / 'Contents/MacOS').iterdir())
    with (fixture / 'app.log').open('a') as log:
        process = subprocess.Popen([str(binary)], env=environment, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    manifest['pid'] = process.pid
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
