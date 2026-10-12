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

parser = argparse.ArgumentParser(description='Prepare or check isolated native Storage settings verification.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path, help='Launch this built Tauri .app after preparation.')
parser.add_argument('--check', action='store_true', help='Print the files, worktrees and settings the app left behind.')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
fixture = args.directory.resolve()
data = fixture / 'data'
day = 86_400


def git(repo, *arguments):
    return subprocess.check_output(['git', '-C', str(repo), *arguments], stderr=subprocess.STDOUT).decode().strip()


def check():
    manifest = json.loads((fixture / 'manifest.json').read_text())
    files = sorted(str(path.relative_to(data)) for folder in ('preview/screenshots', 'logs')
                   for path in (data / folder).rglob('*') if path.is_file())
    worktrees = {name: Path(path).is_dir() for name, path in manifest['worktrees'].items()}
    settings = data / 'settings.json'
    print(json.dumps({'files': files, 'worktreesPresent': worktrees,
                      'settings': json.loads(settings.read_text()) if settings.exists() else None}, indent=2))


def prepare():
    fixture.mkdir(parents=True)
    provider = fixture / 'provider'
    provider.mkdir()
    shutil.copyfile(root / 'crates/bot-core/tests/support/codex_peer.py', provider / 'codex')
    (provider / 'codex').chmod(0o755)
    (data / 'worktrees').mkdir(parents=True)
    now = time.time()
    for name, age in (('old.png', 30), ('fresh.png', 1)):
        path = data / 'preview/screenshots' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'\x89PNG fixture')
        os.utime(path, (now - age * day, now - age * day))
    for name, age in (('codex.log', 30), ('codex.log.1', 1), ('codex.log.2', 30), ('terminals/w/t/x.log', 30)):
        path = data / 'logs' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture log\n')
        os.utime(path, (now - age * day, now - age * day))
    month_ago = int((now - 30 * day) * 1000)
    workspaces, threads, worktrees = [], {}, {}
    for label in ('Storage alpha', 'Storage beta', 'Storage gamma'):
        slug = label.split()[1]
        repo = fixture / slug
        repo.mkdir()
        git(repo, 'init', '-q', '-b', 'main')
        git(repo, 'config', 'user.name', 'Fixture')
        git(repo, 'config', 'user.email', 'fixture@example.invalid')
        (repo / 'README.md').write_text(f'Disposable {label} repository.\n')
        git(repo, 'add', '.')
        git(repo, '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture main')
        branch = f'botcode/{slug}-idle'
        path = data / 'worktrees' / f'{slug}-idle'
        git(repo, 'worktree', 'add', '-q', '-b', branch, str(path))
        workspace = {'id': str(uuid.uuid4()), 'root': str(repo), 'label': label, 'kind': 'repository'}
        workspaces.append(workspace)
        thread_id = str(uuid.uuid4())
        threads[label] = thread_id
        worktrees[label] = str(path)
        turn = {'id': str(uuid.uuid4()), 'prompt': f'Idle work in {label}', 'nativeTurnId': None,
                'delivery': {'kind': 'accepted'}, 'execution': {'kind': 'completed'}, 'items': [],
                'startedAtMs': month_ago - 60_000, 'completedAtMs': month_ago}
        threads[label] = {'id': thread_id, 'workspaceId': workspace['id'], 'title': f'{label} idle worktree',
                          'nativeThreadId': None, 'revision': 1, 'session': {'kind': 'dormant'},
                          'checkout': {'kind': 'worktree', 'path': str(path), 'branch': branch}, 'turns': [turn],
                          'approvals': [], 'diagnostic': None, 'createdAtMs': month_ago - 120_000,
                          'placement': {'kind': 'auto'}, 'snooze': None}
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
        for workspace in workspaces:
            db.execute('INSERT INTO workspaces VALUES(?,?,?)', (workspace['id'], workspace['root'], json.dumps(workspace)))
        for thread in threads.values():
            db.execute('INSERT INTO threads VALUES(?,?,?,0)', (thread['id'], thread['workspaceId'], json.dumps(thread)))
    return {'workspaces': workspaces, 'threads': {label: t['id'] for label, t in threads.items()},
            'worktrees': worktrees, 'data': str(data), 'provider': str(provider / 'codex')}


if args.check:
    check()
    raise SystemExit
manifest = prepare()
if args.app:
    environment = dict(os.environ, BOT_CODE_DATA_DIR=str(data), BOT_CODE_CODEX_BIN=manifest['provider'])
    binary = next((args.app.resolve() / 'Contents/MacOS').iterdir())
    process = subprocess.Popen([str(binary)], env=environment, stdout=(fixture / 'app.log').open('w'),
                               stderr=subprocess.STDOUT, start_new_session=True)
    manifest['pid'] = process.pid
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
