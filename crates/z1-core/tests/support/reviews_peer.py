#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).parent
state = json.loads((root / 'reviews.json').read_text())
args = sys.argv[1:]
with (root / 'reviews-calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
mode = state.get('mode', 'ready')
if mode == 'unauthenticated':
    sys.exit(4)
if mode == 'failed':
    print('fixture gh unavailable', file=sys.stderr)
    sys.exit(1)
if mode == 'oversized':
    print('x' * (3 * 1024 * 1024), flush=True)
    time.sleep(60)
    sys.exit()
if mode == 'slow':
    time.sleep(60)
    sys.exit()
head = state.get('head', 'a' * 40)
def page(nodes, cursor=None):
    return {'nodes': nodes, 'pageInfo': {'hasNextPage': cursor is not None, 'endCursor': cursor}}
def comment(id, body, inline=False):
    value = dict(id=id, body=body, url='https://github.com/test/repo/pull/7#' + id, author={'login': 'review-bot'}, createdAt='2026-10-04T10:00:00Z', updatedAt='2026-10-04T10:00:00Z')
    if inline:
        value.update(originalCommit={'oid': 'b' * 40}, diffHunk='@@ -1 +1 @@\n-old\n+new', path='src/file.ts', originalLine=1)
    return value
if args[:2] == ['pr', 'list']:
    branch = args[args.index('--head') + 1]
    prs = [] if mode == 'no-pr' else [dict(id='PR_fixture', number=7, title='Review fixture', url='https://github.com/test/repo/pull/7', headRefOid=head, headRefName=branch, isCrossRepository=False)]
    if mode == 'unsupported-host':
        prs[0]['url'] = 'https://github.enterprise.invalid/test/repo/pull/7'
    print(json.dumps(prs))
    sys.exit()
fields = dict(arg.split('=', 1) for arg in args if '=' in arg)
query = fields['query']
operation = query.split('(')[0].split()[1]
cursor = fields.get('cursor')
if mode == 'graphql-errors' and operation == 'ReviewsThreads':
    print(json.dumps({'data': None, 'errors': [{'message': 'forbidden review query'}]}))
    sys.exit()
if mode == 'null-node' and operation == 'ReviewsThreads':
    print(json.dumps({'data': {'node': None}}))
    sys.exit()
if operation == 'ReviewsThreads':
    if mode == 'empty':
        node = {'reviewThreads': page([])}
    elif not cursor:
        first = comment('COMMENT_inline', state.get('body', 'Check the boundary'), True)
        node = {'reviewThreads': page([dict(id='THREAD_one', isResolved=False, isOutdated=False, comments=page([first], 'replies-1'))], 'threads-1')}
    elif mode == 'repeated-cursor':
        node = {'reviewThreads': page([], 'threads-1')}
    else:
        node = {'reviewThreads': page([dict(id='THREAD_two', isResolved=True, isOutdated=True, comments=page([comment('COMMENT_old', 'Previously resolved', True)]))])}
        if mode == 'checkout-change':
            subprocess.run(['git', 'checkout', '-q', '-b', 'changed-during-fetch'], check=True)
        if mode == 'page-failure':
            print('later page failed', file=sys.stderr)
            sys.exit(1)
elif operation == 'ReviewReplies':
    reply = comment('COMMENT_reply', 'Reply from the next page', True)
    if mode == 'conflicting-duplicate':
        reply['id'] = 'COMMENT_inline'
    node = {'comments': page([reply])}
elif operation == 'ReviewSummaries':
    if mode == 'empty':
        node = {'reviews': page([])}
    else:
        summary = comment('REVIEW_summary' if not cursor else 'REVIEW_second', 'Review summary' if not cursor else 'Second summary')
        summary['commit'] = {'oid': 'c' * 40}
        node = {'reviews': page([summary], None if cursor else 'reviews-1')}
elif operation == 'ReviewConversation':
    node = {'comments': page([]) if mode == 'empty' else page([comment('ISSUE_comment' if not cursor else 'ISSUE_second', 'General PR feedback')], None if cursor else 'conversation-1')}
elif operation == 'ReviewHead':
    node = {'id': 'PR_fixture', 'headRefOid': 'd' * 40 if mode == 'moving-head' else head}
else:
    raise RuntimeError(operation)
print(json.dumps({'data': {'node': node}}))
