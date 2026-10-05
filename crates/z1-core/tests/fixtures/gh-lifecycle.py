#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

state_path = Path(os.environ.get('Z1_PR_FIXTURE_STATE', str(Path(__file__).with_suffix('.json'))))
state = json.loads(state_path.read_text())
args = sys.argv[1:]
log = state_path.with_suffix('.log')
with log.open('a') as file:
    file.write(json.dumps({'args': args, 'pid': os.getpid(), 'cwd': os.getcwd()}) + '\n')
mode = state.get('mode', 'ok')
if args[:2] == ['pr', 'create']:
    time.sleep(state.get('createDelay', 0))
if args[:2] == ['api', 'graphql'] and state.get('exists') and state.get('failReadAfterCreate'):
    mode = 'error'
if mode == 'slow':
    time.sleep(state.get('delay', 10))
if mode == 'hang':
    child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)'])
    time.sleep(0.05)
    state_path.with_suffix('.pid').write_text(str(child.pid))
    time.sleep(300)
if mode == 'error':
    print('Fixture GitHub unavailable', file=sys.stderr)
    sys.exit(1)
repo = state.get('repository', 'fixture/project')
branch = state.get('branch', 'feature')
sha = state.get('head', 'a' * 40)
number = state.get('number', 41)
url = f'https://github.com/{repo}/pull/{number}'
row = {'number': number, 'title': state.get('title', 'Durable fixture pull request'), 'url': url,
       'baseRefName': 'main', 'headRefName': branch, 'isCrossRepository': False}
pr = {'id': f'PR_fixture_{number}', **row, 'state': state.get('lifecycle', 'OPEN'),
      'isDraft': state.get('draft', False), 'headRefOid': sha,
      'headRepository': {'nameWithOwner': state.get('headRepository', repo)},
      'baseRepository': {'nameWithOwner': repo}, 'updatedAt': state.get('updatedAt', '2026-10-05T12:00:00Z'),
      'closedAt': state.get('closedAt'), 'mergedAt': state.get('mergedAt')}
if args[:2] == ['pr', 'create']:
    state['exists'] = True
    state_path.write_text(json.dumps(state))
    print(url)
elif args[:2] == ['pr', 'view']:
    print(json.dumps(row))
elif args[:2] == ['pr', 'list']:
    print(json.dumps([row] if state.get('exists', True) else []))
elif args[:2] == ['api', 'graphql']:
    query = ' '.join(args)
    if 'Z1Discover' in query:
        found = [pr] if state.get('exists', True) else []
        if mode == 'ambiguous':
            found.append({**pr, 'number': number + 1, 'url': f'https://github.com/{repo}/pull/{number + 1}'})
        print(json.dumps({'data': {'repository': {'pullRequests': {'nodes': found, 'pageInfo': {'hasNextPage': False}}}}}))
    elif 'Z1PullRequest' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': pr}}}))
    else:
        print('Unsupported fixture GraphQL operation', file=sys.stderr)
        sys.exit(2)
else:
    print('Unsupported fixture request ' + repr(args), file=sys.stderr)
    sys.exit(2)
