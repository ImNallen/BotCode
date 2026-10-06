#!/usr/bin/env python3
import json
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time

state_path = Path(os.environ.get('BOT_CODE_PR_FIXTURE_STATE', str(Path(__file__).with_suffix('.json'))))
state = json.loads(state_path.read_text())
args = sys.argv[1:]
log = state_path.with_suffix('.log')
payload = None
if '--input' in args:
    input_path = Path(args[args.index('--input') + 1])
    payload = json.loads(input_path.read_text())
query = payload['query'] if payload else ' '.join(args)
variables = payload.get('variables', {}) if payload else dict(arg.split('=', 1) for arg in args if '=' in arg)
node = variables.get('input', {}).get('pullRequestId', '')
node_number = int(node.removeprefix('PR_fixture_')) if node.startswith('PR_fixture_') else state.get('number', 41)
number = int(variables.get('number', node_number)) if state.get('matchNumber') else state.get('number', 41)
scoped = str(number) in state.get('perNumber', {})
state = {**state, **state.get('perNumber', {}).get(str(number), {})}

def update_state(update):
    with state_path.with_suffix('.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = json.loads(state_path.read_text())
        if scoped:
            selected = {**current, **current['perNumber'][str(number)]}
            selected.pop('perNumber', None)
            before = selected.copy()
            update(selected)
            current['perNumber'][str(number)].update({key: value for key, value in selected.items() if key not in before or before[key] != value})
        else:
            update(current)
        temporary = state_path.with_suffix(f'.{os.getpid()}.next')
        temporary.write_text(json.dumps(current))
        temporary.replace(state_path)
        return {**current, **current.get('perNumber', {}).get(str(number), {})}

entry = {'args': args, 'pid': os.getpid(), 'cwd': os.getcwd()}
if payload is not None:
    entry.update(payload=payload, inputMode=oct(input_path.stat().st_mode & 0o777))
with log.open('a') as file:
    file.write(json.dumps(entry) + '\n')
for operation, release in state.get('waitFor', {}).items():
    name, _, target = operation.partition(':')
    if name in query and (not target or target == str(number)):
        while not Path(release).exists() and state_path.exists():
            time.sleep(0.01)
mode = state.get('mode', 'ok')
for operation, operation_mode in state.get('sectionModes', {}).items():
    if operation in ' '.join(args):
        mode = operation_mode
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
    with state_path.with_suffix('.children').open('a') as file:
        file.write(str(child.pid) + '\n')
    time.sleep(300)
if mode == 'error':
    print('Fixture GitHub unavailable', file=sys.stderr)
    sys.exit(1)
repo = state.get('repository', 'fixture/project')
branch = state.get('branch', 'feature')
sha = state.get('head', 'a' * 40)
url = f'https://github.com/{repo}/pull/{number}'
row = {'number': number, 'title': state.get('title', 'Durable fixture pull request'), 'url': url,
       'baseRefName': 'main', 'headRefName': branch, 'isCrossRepository': False}
pr = {'id': state.get('nodeId', f'PR_fixture_{number}'), **row, 'state': state.get('lifecycle', 'OPEN'),
      'isDraft': state.get('draft', False), 'headRefOid': sha,
      'mergeable': state.get('mergeable', 'MERGEABLE'), 'mergeStateStatus': state.get('mergeStateStatus', 'CLEAN'),
      'isMergeQueueEnabled': state.get('queueRequired', False), 'mergeQueueEntry': {'id':'QUEUE_saved'} if state.get('queued') else None,
      'autoMergeRequest': {'mergeMethod': state.get('autoMethod','SQUASH')} if state.get('autoMerge') else None,
      **{key: state.get(key, True) for key in ['viewerCanClose','viewerCanReopen','viewerCanUpdate','viewerCanUpdateBranch','viewerCanEnableAutoMerge','viewerCanDisableAutoMerge']},
      'headRepository': {'nameWithOwner': state.get('headRepository', repo)},
      'baseRepository': {'nameWithOwner': repo}, 'updatedAt': state.get('updatedAt', '2026-10-05T12:00:00Z'),
      'closedAt': state.get('closedAt'), 'mergedAt': state.get('mergedAt'),
      'createdAt': state.get('createdAt', '2026-10-01T12:00:00Z'), 'author': {'login': state.get('author', 'fixture-author'), 'avatarUrl': state.get('authorAvatar')},
      'additions': state.get('additions', 1), 'deletions': state.get('deletions', 1), 'changedFiles': state.get('changedFiles', 1),
      'labels': {'nodes': state.get('labels', [])}, 'reviewRequests': {'nodes': state.get('reviewRequests', [])},
      'latestReviews': {'nodes': state.get('latestReviews', [])}}
if args[:2] == ['pr', 'create']:
    state['exists'] = True
    state_path.write_text(json.dumps(state))
    print(url)
elif args[:2] == ['pr', 'view']:
    print(json.dumps(row))
elif args[:2] == ['pr', 'list']:
    print(json.dumps([row] if state.get('exists', True) else []))
elif args[:2] == ['api', 'graphql']:
    operation = query.split('query ')[-1].split('(')[0]
    if operation in state.get('failSections', []):
        print(json.dumps({'errors': [{'message': 'Fixture section unavailable'}]}))
        sys.exit(0)
    if operation in state.get('wrongIdentitySections', []):
        pr['id'] = 'PR_other'
    page = int(variables.get('cursor') or '0')
    def connection(nodes):
        pages = state.get('pages', 1)
        return {'nodes': nodes, 'pageInfo': {'hasNextPage': page + 1 < pages, 'endCursor': str(page + 1)}}
    comment = {'id': 'COMMENT_' + str(page), 'body': 'Validate negative inputs.', 'url': url + '#discussion_r1', 'author': {'login': 'reviewer'}, 'createdAt': state.get('threadAt', '2026-10-05T12:00:00Z'), 'updatedAt': '2026-10-05T12:00:00Z', 'originalCommit': {'oid': 'b' * 40}, 'diffHunk': '@@ -1 +1 @@\n-old\n+new', 'path': 'calculate.ts', 'originalLine': 1}
    thread = {'id': 'THREAD_' + str(page), 'isResolved': state.get('resolved', False), 'isOutdated': state.get('outdated', True), 'viewerCanReply': state.get('canReply', True), 'viewerCanResolve': state.get('canResolve', True), 'viewerCanUnresolve': state.get('canUnresolve', True), 'comments': {'nodes': [comment], 'pageInfo': {'hasNextPage': state.get('replyPages', False), 'endCursor': '1'}}}
    if 'mutation Bot' in query:
        time.sleep(state.get('mutationDelay', 0))
        if state.get('mutation') == 'refuse':
            print(json.dumps({'errors': [{'message': 'Fixture refused mutation'}]}))
            sys.exit(0)
        if state.get('mutation') == 'uncertain':
            time.sleep(300)
        lifecycle = next((name for name in ['mergePullRequest','enqueuePullRequest','enablePullRequestAutoMerge','disablePullRequestAutoMerge','convertPullRequestToDraft','markPullRequestReadyForReview','closePullRequest','reopenPullRequest','updatePullRequestBranch'] if name + '(input:' in query), None)
        if lifecycle and variables['input'].get('expectedHeadOid', sha) != state.get('atomicHead', sha):
            print(json.dumps({'errors':[{'message':'Head moved. Refresh before retrying.'}]}))
            sys.exit(0)
        field = lifecycle or ('updatePullRequest' if 'BotEdit' in query else 'addPullRequestReview' if 'BotSubmitReview' in query else 'addPullRequestReviewThreadReply' if 'BotReply' in query else 'unresolveReviewThread' if 'BotUnresolve' in query else 'resolveReviewThread')
        def save_mutation(current):
            current['submitted'] = current.get('submitted', []) + [payload]
            if field in ['resolveReviewThread', 'unresolveReviewThread']:
                current['resolved'] = field == 'resolveReviewThread'
            if field == 'mergePullRequest':
                current.update(lifecycle='MERGED', mergedAt=current.get('terminalAt','2099-10-05T13:00:00Z'))
            elif field == 'enqueuePullRequest': current['queued'] = True
            elif field == 'enablePullRequestAutoMerge': current.update(autoMerge=True, autoMethod=variables['input']['mergeMethod'])
            elif field == 'disablePullRequestAutoMerge': current['autoMerge'] = False
            elif field in ['convertPullRequestToDraft','markPullRequestReadyForReview']: current['draft'] = field == 'convertPullRequestToDraft'
            elif field == 'closePullRequest': current.update(lifecycle='CLOSED', closedAt=current.get('terminalAt','2099-10-05T13:00:00Z'))
            elif field == 'reopenPullRequest': current.update(lifecycle='OPEN', closedAt=None)
            elif field == 'updatePullRequestBranch': current.update(head='d'*40, viewerCanUpdateBranch=False)
            elif field == 'updatePullRequest': current.update({key: variables['input'][key] for key in ['title', 'body'] if key in variables['input']})
            if current.get('failReadAfterReview') or (lifecycle and current.get('failConfirmation')):
                current['mode'] = 'error'
        state = update_state(save_mutation)
        child = 'mergeQueueEntry' if field == 'enqueuePullRequest' else 'pullRequest' if lifecycle or field == 'updatePullRequest' else 'pullRequestReview' if field == 'addPullRequestReview' else 'comment' if field == 'addPullRequestReviewThreadReply' else 'thread'
        print(json.dumps({'data': {field: {child: {'id': 'REVIEW_saved' if child == 'pullRequestReview' else 'COMMENT_saved' if child == 'comment' else pr['id'] if lifecycle or field == 'updatePullRequest' else variables['input']['threadId']}}}}))
    elif 'BotReviewMeta' in query:
        time.sleep(state.get('metaDelay', 0))
        def count_meta(current):
            current['metaCalls'] = current.get('metaCalls', 0) + 1
        state = update_state(count_meta)
        if state.get('failCore') or (state.get('failFinal') and state['metaCalls'] > 1):
            print(json.dumps({'errors': [{'message': 'Fixture core unavailable'}]}))
            sys.exit(0)
        if state['metaCalls'] > 1:
            pr.update(state.get('finalMeta', {}))
        print(json.dumps({'data': {'viewer': {'login': state.get('finalViewer', state.get('viewer', 'fixture-viewer')) if state['metaCalls'] > 1 else state.get('viewer', 'fixture-viewer')}, 'repository': {**{key: state.get(key, True) for key in ['mergeCommitAllowed','squashMergeAllowed','rebaseMergeAllowed','autoMergeAllowed']}, 'viewerPermission': state.get('viewerPermission','WRITE'), 'pullRequest': {**pr, 'body': state.get('body', 'Review the calculation update.'), 'reviewDecision': 'CHANGES_REQUESTED', 'locked': pr.get('locked', state.get('locked', False)), 'viewerDidAuthor': pr.get('viewerDidAuthor', state.get('didAuthor', False))}}}}))
    elif 'BotReviewThreads' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'reviewThreads': connection([thread])}}}}))
    elif 'BotReviewReplies' in query:
        print(json.dumps({'data': {'node': {'id': variables['id'], 'pullRequest': {'id': 'PR_other' if state.get('crossPrReply') else pr['id']}, 'comments': {'nodes': [{**comment, 'id': 'REPLY_' + str(page)}], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}}}))
    elif 'BotReviewConversation' in query or 'BotReviewSummaries' in query:
        field = 'reviews' if 'BotReviewSummaries' in query else 'comments'
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, field: connection([{**comment, 'id': field.upper() + '_' + str(page), 'state': 'CHANGES_REQUESTED', 'createdAt': state.get('reviewAt' if field == 'reviews' else 'commentAt', comment['createdAt'])}])}}}}))
    elif 'BotReviewCommits' in query:
        commits = state.get('commits', [{'oid': 'c' * 40, 'messageHeadline': 'Validate input', 'committedDate': '2026-10-03T12:00:00Z', 'author': {'name': 'Contributor', 'user': {'login': 'contributor'}}}])
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'commits': connection([{'commit': commit} for commit in commits])}}}}))
    elif 'BotReviewChecks' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'statusCheckRollup': {'contexts': connection([{'__typename': 'CheckRun', 'name': 'unit tests', 'status': 'COMPLETED', 'conclusion': state.get('checkConclusion', 'FAILURE'), 'detailsUrl': url + '/checks'}])}}}}}))
    elif 'BotReviewThread' in query:
        print(json.dumps({'data': {'node': {**thread, 'id': variables['id'], 'pullRequest': {'id': 'PR_other' if state.get('crossPrThread') else pr['id']}}}}))
    elif 'BotDiscover' in query:
        found = [pr] if state.get('exists', True) else []
        if mode == 'ambiguous':
            found.append({**pr, 'number': number + 1, 'url': f'https://github.com/{repo}/pull/{number + 1}'})
        print(json.dumps({'data': {'repository': {'pullRequests': {'nodes': found, 'pageInfo': {'hasNextPage': False}}}}}))
    elif 'BotPullRequest' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': pr}}}))
    else:
        print('Unsupported fixture GraphQL operation', file=sys.stderr)
        sys.exit(2)
elif args[:1] == ['api'] and '/files?' in args[1]:
    if 'files' in state.get('failSections', []):
        print('Fixture files unavailable', file=sys.stderr)
        sys.exit(1)
    page = int(args[1].split('page=')[-1])
    files = [{'filename': 'calculate.ts', 'status': 'modified', 'additions': 1, 'deletions': 1, 'patch': '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;'}]
    files = state.get('files', files)
    if state.get('missingPatch'):
        files[0].pop('patch')
    if state.get('filePages'):
        files = [{**files[0], 'filename': f'file-{page}-{index}.ts'} for index in range(100)]
    print(json.dumps(files))
else:
    print('Unsupported fixture request ' + repr(args), file=sys.stderr)
    sys.exit(2)
