#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
root = pathlib.Path(__file__).parent
state = root / 'prs.json'
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
if os.environ.get('GH_PROMPT_DISABLED') != '1':
    sys.exit(3)
if (root / 'unauthenticated').exists():
    print('To get started with GitHub CLI, please run:  gh auth login', file=sys.stderr)
    sys.exit(4)
prs = json.loads(state.read_text()) if state.exists() else []
def option(name):
    return args[args.index(name) + 1]
def project(pr):
    return {field: pr[field] for field in option('--json').split(',')}
if args[:2] == ['api', 'graphql']:
    variables = dict(arg.split('=', 1) for arg in args if '=' in arg)
    rows = []
    for pr in prs:
        if pr['headRefName'] == variables.get('head', pr['headRefName']) and pr['state'] == 'OPEN':
            rows.append({**pr, 'id': f"PR_{pr['number']}", 'isDraft': False, 'headRefOid': 'a' * 40, 'headRepository': {'nameWithOwner': 'bot-code/fixture'}, 'baseRepository': {'nameWithOwner': 'bot-code/fixture'}, 'updatedAt': '2026-10-05T12:00:00Z', 'closedAt': None, 'mergedAt': None})
    if 'BotDiscover' in variables.get('query', ''):
        print(json.dumps({'data': {'repository': {'pullRequests': {'nodes': rows, 'pageInfo': {'hasNextPage': False}}}}}))
    else:
        print(json.dumps({'data': {'repository': {'pullRequest': rows[0] if rows else None}}}))
elif args[:2] == ['pr', 'list']:
    head = option('--head')
    print(json.dumps([project(pr) for pr in prs if pr['headRefName'] == head and pr['state'] == 'OPEN']))
elif args[:2] == ['pr', 'view']:
    print(json.dumps(project(next(pr for pr in prs if pr['url'] == args[2]))))
elif args[:2] == ['pr', 'create'] and '--fill' in args:
    base, head = option('--base'), option('--head')
    remote = subprocess.run(['git', 'ls-remote', 'origin', f'refs/heads/{head}'], capture_output=True, text=True)
    if not remote.stdout.strip():
        print('pull request create failed: GraphQL: Head sha can\'t be blank', file=sys.stderr)
        sys.exit(1)
    title = subprocess.run(['git', 'log', '-1', '--format=%s', remote.stdout.split()[0]], capture_output=True, text=True).stdout.strip()
    number = len(prs) + 1
    url = f'https://github.com/bot-code/fixture/pull/{number}'
    prs.append({'number': number, 'title': title, 'url': url, 'baseRefName': base, 'headRefName': head,
                'isCrossRepository': False, 'state': 'OPEN'})
    state.write_text(json.dumps(prs))
    print(url)
else:
    print(f'unsupported: {args}', file=sys.stderr)
    sys.exit(2)
