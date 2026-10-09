#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description='Prepare or launch isolated native PR stack verification.')
parser.add_argument('directory', type=Path)
parser.add_argument('--app', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
fixture = args.directory.resolve()
if not (fixture / 'manifest.json').exists():
    subprocess.run(['python3', str(root / 'scripts/pr-handoff-fixture.py'), str(fixture)], check=True, stdout=subprocess.DEVNULL)
manifest = json.loads((fixture / 'manifest.json').read_text())
repo = fixture / 'repo'


def git(*arguments):
    return subprocess.check_output(['git', '-C', str(repo), *arguments], stderr=subprocess.STDOUT).decode().strip()


if 'stackHeads' not in manifest:
    heads = [manifest['head']]
    for branch, base in [('stack-middle', 'feature'), ('stack-top', 'stack-middle')]:
        git('checkout', '-qb', branch, base)
        (repo / f'{branch}.txt').write_text(f'{branch}\n')
        git('add', '.')
        git('commit', '-qm', branch)
        heads.append(git('rev-parse', 'HEAD'))
    git('checkout', 'main')
    remote = fixture / 'remote.git'
    for number, branch, head in zip([41, 42, 43], ['feature', 'stack-middle', 'stack-top'], heads):
        subprocess.run(['git', '--git-dir', str(remote), 'fetch', '-q', str(repo), f'{branch}:{branch}'], check=True)
        subprocess.run(['git', '--git-dir', str(remote), 'update-ref', f'refs/pull/{number}/head', head], check=True)
    manifest['stackHeads'] = heads
    (fixture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
state_path = fixture / 'gh.json'
if 'stack' not in json.loads(state_path.read_text()):
    heads = manifest['stackHeads']
    state = json.loads(state_path.read_text())
    state.update(matchNumber=True, title='Stack foundation', stack={
        'id': 50, 'number': 50, 'url': 'https://api.github.com/repos/fixture/project/stacks/50',
        'html_url': 'https://github.com/fixture/project/stack/50', 'base': {'ref': 'main'},
        'pull_requests': [
            {'number': number, 'title': title, 'draft': False, 'state': 'open',
             'head': {'ref': branch, 'sha': head}}
            for number, title, branch, head in zip(
                [41, 42, 43], ['Stack foundation', 'Stack middle layer', 'Stack top layer'],
                ['feature', 'stack-middle', 'stack-top'], heads)
        ],
    }, perNumber={
        str(number): {'title': title, 'branch': branch, 'head': head, 'base': base}
        for number, title, branch, head, base in zip(
            [41, 42, 43], ['Stack foundation', 'Stack middle layer', 'Stack top layer'],
            ['feature', 'stack-middle', 'stack-top'], heads, ['main', 'feature', 'stack-middle'])
    })
    state_path.write_text(json.dumps(state, indent=2))
state = json.loads(state_path.read_text())
if 'inboxRows' not in state:
    state['inboxRows'] = [
        {'number': layer['number'], 'title': layer['title'], 'headRefName': layer['head']['ref'],
         'author': {'login': 'fixture-viewer', 'avatarUrl': None}, 'isDraft': layer.get('draft', False),
         'state': layer.get('state', 'open').upper()}
        for layer in state.get('stack', {}).get('pull_requests', [])
    ]
    state_path.write_text(json.dumps(state, indent=2))
if args.app:
    app = args.app.resolve()
    environment = dict(os.environ, BOT_CODE_DATA_DIR=str(fixture / 'data'),
        BOT_CODE_GH_BIN=str(root / 'crates/bot-core/tests/fixtures/gh-lifecycle.py'),
        BOT_CODE_PR_FIXTURE_STATE=str(state_path), BOT_CODE_CODEX_BIN=str(fixture / 'provider/codex'))
    process = subprocess.Popen([str(app / 'Contents/MacOS/bot-code')], env=environment,
        stdout=(fixture / 'app.log').open('w'), stderr=subprocess.STDOUT, start_new_session=True)
    (fixture / 'app.pid').write_text(str(process.pid))
    manifest['pid'] = process.pid
print(json.dumps(manifest, indent=2))
