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

parser = argparse.ArgumentParser(description='Prepare isolated native sidebar parity verification.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path, help='Launch this built Tauri .app after preparation.')
parser.add_argument('--snooze-seconds', type=int, default=120, help='Wake time of the snoozed thread.')
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
(repo / 'README.md').write_text('Disposable sidebar parity repository.\n')
git('add', '.')
git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture main')
provider = fixture / 'provider'
provider.mkdir()
shutil.copyfile(root / 'crates/bot-core/tests/support/codex_peer.py', provider / 'codex')
(provider / 'codex').chmod(0o755)
data = fixture / 'data'
data.mkdir()
now = int(time.time() * 1000)
minute = 60_000
workspace_id = str(uuid.uuid4())
workspace = {'id': workspace_id, 'root': str(repo), 'label': 'Sidebar parity fixture', 'kind': 'repository'}


def turn(prompt, completed_ago):
    return {'id': str(uuid.uuid4()), 'prompt': prompt, 'nativeTurnId': None, 'delivery': {'kind': 'accepted'},
            'execution': {'kind': 'completed'}, 'items': [], 'startedAtMs': now - completed_ago - minute,
            'completedAtMs': now - completed_ago}


threads = [
    ('Pinned alpha', 50, {'kind': 'pinned', 'atMs': now - 30 * minute}, None),
    ('Pinned beta', 40, {'kind': 'pinned', 'atMs': now - 20 * minute}, None),
    ('Pinned gamma', 30, {'kind': 'pinned', 'atMs': now - 10 * minute}, None),
    ('Active one', 4, {'kind': 'auto'}, None),
    ('Active two', 3, {'kind': 'auto'}, None),
    ('Active three', 2, {'kind': 'auto'}, None),
    ('Active four', 1, {'kind': 'auto'}, None),
    ('Snoozed soon', 60, {'kind': 'auto'}, {'untilMs': now + args.snooze_seconds * 1000, 'atMs': now - minute}),
    ('Settled old', 120, {'kind': 'settled', 'atMs': now - 100 * minute}, None),
]
ids = {}
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
    for title, minutes_ago, placement, snooze in threads:
        thread_id = str(uuid.uuid4())
        ids[title] = thread_id
        thread = {'id': thread_id, 'workspaceId': workspace_id, 'title': title, 'nativeThreadId': None, 'revision': 1,
                  'session': {'kind': 'dormant'}, 'checkout': {'kind': 'local'},
                  'turns': [turn(f'Fixture prompt for {title}', minutes_ago * minute)], 'approvals': [],
                  'diagnostic': None, 'createdAtMs': now - (minutes_ago + 5) * minute,
                  'placement': placement, 'snooze': snooze}
        db.execute('INSERT INTO threads VALUES(?,?,?,0)', (thread_id, workspace_id, json.dumps(thread)))
manifest = {'workspace': workspace, 'threads': ids, 'data': str(data), 'provider': str(provider / 'codex')}
if args.app:
    app = args.app.resolve()
    environment = dict(os.environ, BOT_CODE_DATA_DIR=str(data), BOT_CODE_CODEX_BIN=str(provider / 'codex'))
    binary = next((app / 'Contents/MacOS').iterdir())
    process = subprocess.Popen([str(binary)], env=environment, stdout=(fixture / 'app.log').open('w'),
                               stderr=subprocess.STDOUT, start_new_session=True)
    manifest['pid'] = process.pid
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
