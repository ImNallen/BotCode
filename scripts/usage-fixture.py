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

parser = argparse.ArgumentParser(description='Prepare or check isolated native verification of usage reset credits and model prices.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path, help='Launch this built Tauri .app after preparation.')
parser.add_argument('--check', action='store_true', help='Print the redemptions the fake Codex received and the saved model prices.')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
fixture = args.directory.resolve()
data = fixture / 'data'
provider = fixture / 'provider'
codex_home = fixture / 'codex-home'
LITELLM = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
PRICED = 'gpt-5.5'
UNPRICED = 'vendor/Custom-Model'


def check():
    calls = provider / 'calls.jsonl'
    consumed = [json.loads(line)['params'] for line in calls.read_text().splitlines()
                if json.loads(line).get('method') == 'account/rateLimitResetCredit/consume'] if calls.exists() else []
    settings = data / 'settings.json'
    print(json.dumps({
        'consumeCalls': consumed,
        'resetCredits': json.loads((provider / 'reset_credits').read_text()),
        'usagePriceOverrides': json.loads(settings.read_text()).get('usagePriceOverrides') if settings.exists() else None,
    }, indent=2))


def line(value):
    return json.dumps(value) + '\n'


def usage(at, input_tokens, cached, output):
    return line({'type': 'event_msg', 'timestamp': at, 'payload': {'type': 'token_count', 'info': {'last_token_usage': {
        'input_tokens': input_tokens, 'cached_input_tokens': cached, 'cache_write_input_tokens': 0,
        'output_tokens': output, 'reasoning_output_tokens': 0}}}})


def prepare():
    fixture.mkdir(parents=True)
    provider.mkdir()
    shutil.copyfile(root / 'crates/l1-core/tests/support/codex_peer.py', provider / 'codex')
    (provider / 'codex').chmod(0o755)
    now = time.time()
    (provider / 'reset_credits').write_text(json.dumps({'availableCount': 2, 'credits': [
        {'id': f'credit-{n}', 'grantedAt': int(now) - 86_400, 'expiresAt': int(now) + days * 86_400 + 3600,
         'status': 'available', 'resetType': 'codexRateLimits'} for n, days in ((1, 27), (2, 40))]}))
    (provider / 'consume_outcomes').write_text(json.dumps(['reset', 'noCredit']))

    sessions = codex_home / 'sessions' / time.strftime('%Y/%m/%d', time.gmtime(now))
    sessions.mkdir(parents=True)
    stamp = lambda minutes: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now - minutes * 60))
    (sessions / 'rollout-usage-fixture.jsonl').write_text(
        line({'type': 'session_meta', 'timestamp': stamp(90), 'payload': {'id': str(uuid.uuid4())}})
        + line({'type': 'turn_context', 'payload': {'model': PRICED}})
        + usage(stamp(90), 1_200_000, 400_000, 60_000)
        + usage(stamp(60), 800_000, 300_000, 40_000)
        + line({'type': 'turn_context', 'payload': {'model': UNPRICED}})
        + usage(stamp(30), 500_000, 100_000, 25_000))

    data.mkdir()
    (data / 'usage-model-rates.json').write_text(json.dumps({
        'version': 1, 'source': LITELLM, 'fetchedAtMs': int(now * 1000),
        'document': {PRICED: {'input_cost_per_token': 1.25e-6, 'output_cost_per_token': 1e-5,
                              'cache_read_input_token_cost': 1.25e-7}}}))
    repo = fixture / 'repo'
    repo.mkdir()
    for arguments in (['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'],
                      ['config', 'user.email', 'fixture@example.invalid']):
        subprocess.check_call(['git', '-C', str(repo), *arguments])
    (repo / 'README.md').write_text('Disposable usage fixture repository.\n')
    subprocess.check_call(['git', '-C', str(repo), 'add', '.'])
    subprocess.check_call(['git', '-C', str(repo), '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture main'])
    workspace = {'id': str(uuid.uuid4()), 'root': str(repo), 'label': 'Usage fixture', 'kind': 'repository'}
    with sqlite3.connect(data / 'l1code.sqlite') as db:
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
        db.execute('INSERT INTO workspaces VALUES(?,?,?)', (workspace['id'], workspace['root'], json.dumps(workspace)))
    return {'workspace': workspace, 'data': str(data), 'codexHome': str(codex_home),
            'provider': str(provider / 'codex'), 'pricedModel': PRICED, 'unpricedModel': UNPRICED}


if args.check:
    check()
    raise SystemExit
manifest = prepare()
if args.app:
    environment = dict(os.environ, L1_CODE_DATA_DIR=str(data), L1_CODE_CODEX_BIN=manifest['provider'],
                       CODEX_HOME=str(codex_home))
    binary = next((args.app.resolve() / 'Contents/MacOS').iterdir())
    process = subprocess.Popen([str(binary)], env=environment, stdout=(fixture / 'app.log').open('w'),
                               stderr=subprocess.STDOUT, start_new_session=True)
    manifest['pid'] = process.pid
(fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
