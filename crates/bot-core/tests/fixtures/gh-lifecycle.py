#!/usr/bin/env python3
import json
import base64
from urllib.parse import unquote
import fcntl
import os
import re
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
query = payload.get('query', ' '.join(args)) if payload else ' '.join(args)
variables = payload.get('variables', {}) if payload else dict(arg.split('=', 1) for arg in args if '=' in arg)
node = variables.get('input', {}).get('pullRequestId', variables.get('pullRequestId', ''))
subject = variables.get('input', {}).get('subjectId', variables.get('id', ''))
node = node or subject
node_number = int(node.removeprefix('PR_fixture_')) if re.fullmatch(r'PR_fixture_\d+', node) else state.get('number', 41)
if subject and not re.fullmatch(r'PR_fixture_\d+', subject):
    for candidate_number, candidate in state.get('perNumber', {}).items():
        scope = candidate.get('subjectScope', {}).get(subject)
        if scope is not None:
            parent = scope.get('prId', f'PR_fixture_{candidate_number}')
            if parent == f'PR_fixture_{candidate_number}':
                node_number = int(candidate_number)
                break
rest_number = next((int(match[1]) for arg in args if (match := re.search(r'/(?:pulls|issues)/(\d+)/', arg))), node_number)
number = int(variables.get('number', rest_number)) if state.get('matchNumber') else state.get('number', 41)
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
if 'BotReviewMeta' in query and state.get('metaHeads'):
    meta_index = state.get('metaIndex', 0)
    sha = state['metaHeads'][min(meta_index, len(state['metaHeads']) - 1)]
    update_state(lambda current: current.update(metaIndex=current.get('metaIndex', 0) + 1))
url = f'https://github.com/{repo}/pull/{number}'
row = {'number': number, 'title': state.get('title', 'Durable fixture pull request'), 'url': url,
       'baseRefName': 'main', 'headRefName': branch, 'isCrossRepository': False}
pr = {'id': state.get('nodeId', f'PR_fixture_{number}'), **row, 'state': state.get('lifecycle', 'OPEN'),
      'isDraft': state.get('draft', False), 'headRefOid': sha, 'baseRefOid': state.get('baseRefOid', 'e' * 40),
      'mergeable': state.get('mergeable', 'MERGEABLE'), 'mergeStateStatus': state.get('mergeStateStatus', 'CLEAN'),
      'isMergeQueueEnabled': state.get('queueRequired', False), 'mergeQueueEntry': {'id':'QUEUE_saved'} if state.get('queued') else None,
      'autoMergeRequest': {'mergeMethod': state.get('autoMethod','SQUASH')} if state.get('autoMerge') else None,
      **{key: state.get(key, True) for key in ['viewerCanClose','viewerCanReopen','viewerCanUpdate','viewerCanUpdateBranch','viewerCanEnableAutoMerge','viewerCanDisableAutoMerge']},
      'headRepository': {'nameWithOwner': state.get('headRepository', repo)},
      'baseRepository': {'nameWithOwner': repo}, 'updatedAt': state.get('updatedAt', '2026-10-05T12:00:00Z'),
      'closedAt': state.get('closedAt'), 'mergedAt': state.get('mergedAt'),
      'createdAt': state.get('createdAt', '2026-10-01T12:00:00Z'), 'author': {'login': state.get('author', 'fixture-author'), 'avatarUrl': state.get('authorAvatar')},
      'additions': state.get('additions', 1), 'deletions': state.get('deletions', 1), 'changedFiles': state.get('changedFiles', 1),
      'reactionGroups': state.get('reactionGroups', []), 'labels': {'nodes': state.get('labels', [])}, 'reviewRequests': {'nodes': state.get('reviewRequests', [])},
      'latestReviews': {'nodes': state.get('latestReviews', [])}}
if args[:2] == ['api', '--method']:
    method = args[2]
    path = next(arg for arg in args if arg.startswith('repos/'))
    picker_mode = state.get('pickerMutationMode', 'ok')
    if picker_mode == 'refused':
        print(json.dumps({'message': 'Fixture host refused this change.'}))
        sys.exit(0)
    def change_picker(current):
        current['pickerMutations'] = current.get('pickerMutations', []) + [{'method': method, 'path': path, 'body': payload}]
        if '/labels' in path:
            labels = current.get('labels', [])
            if method == 'POST':
                defined = {label['name']: label for label in current.get('labelCandidates', [])}
                for name in payload['labels']:
                    if not any(label['name'] == name for label in labels): labels.append({'name': name, 'color': defined.get(name, {}).get('color', 'ff0000')})
            else:
                name = unquote(path.split('/labels/')[1])
                labels = [label for label in labels if label['name'] != name]
            current['labels'] = labels
        else:
            requests = current.get('reviewRequests', [])
            for field, kind in [('reviewers', 'login'), ('team_reviewers', 'slug')]:
                for login in payload[field]:
                    if method == 'POST' and not any(request['requestedReviewer'].get(kind) == login for request in requests): requests.append({'requestedReviewer': {kind: login, 'name': login, 'avatarUrl': None}})
                    if method == 'DELETE': requests = [request for request in requests if request['requestedReviewer'].get(kind) != login]
            current['reviewRequests'] = requests
    if picker_mode != 'uncertain': state = update_state(change_picker)
    if picker_mode in ['uncertain', 'acceptThenUncertain']:
        print('connection lost', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(state.get('labels', []) if '/labels' in path else {'requested_reviewers': state.get('reviewRequests', [])}))
elif args[:2] == ['pr', 'create']:
    state['exists'] = True
    state_path.write_text(json.dumps(state))
    print(url)
elif args[:2] == ['pr', 'view']:
    print(json.dumps(row))
elif args[:2] == ['api', 'graphql'] and 'BotInboxList' in query:
    search_query = variables['search']
    if any(partition in search_query for partition in state.get('inboxFailPartitions', [])):
        sys.exit(1)
    repository = re.search(r'repo:([^ ]+)', search_query)[1]
    if repository in state.get('inboxFailures', []):
        sys.exit(1)
    viewer = state.get('viewer', 'fixture-viewer')
    rows = state.get('inboxRows')
    if rows is None:
        rows = [
            {'number': 41, 'title': 'Authored calculation update', 'author': {'login': viewer, 'avatarUrl': None}, 'labels': [{'name': 'bug', 'color': 'ff0000'}], 'reviewDecision': 'APPROVED'},
            {'number': 42, 'title': 'Review requested update', 'author': {'login': 'reviewer', 'avatarUrl': None}, 'reviewRequests': [{'login': viewer}], 'labels': [{'name': 'needs design', 'color': '00ff00'}]},
            {'number': 43, 'title': 'Other project change', 'author': {'login': 'someone', 'avatarUrl': None}, 'isDraft': True, 'reviewDecision': 'CHANGES_REQUESTED'},
        ]
    query = search_query
    normalized = []
    for row in rows:
        row = {'headRefName': 'feature', 'baseRefName': 'main', 'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE', 'additions': 1, 'deletions': 1, 'createdAt': '2026-10-01T12:00:00Z', 'updatedAt': '2026-10-05T12:00:00Z', 'reviewRequests': [], 'reviewDecision': '', 'labels': [], 'statusCheckRollup': [{'conclusion': 'SUCCESS'}], **row}
        saved = state.get('perNumber', {}).get(str(row['number']), {})
        if row['number'] == state.get('number', 41):
            saved = {**state, **saved}
        if 'lifecycle' in saved:
            row['state'] = saved['lifecycle']
        if 'title' in saved:
            row['title'] = saved['title']
        row.setdefault('url', f"https://github.com/{repository}/pull/{row['number']}")
        requested_state = 'merged' if 'is:merged' in query and '-is:merged' not in query else 'closed' if 'is:closed' in query else 'open' if 'is:open' in query else 'all'
        if requested_state != 'all' and row['state'].lower() != requested_state:
            continue
        if '-is:merged' in query and row['state'] == 'MERGED':
            continue
        if f'author:{viewer}' in query and row.get('author', {}).get('login') != viewer:
            continue
        if f'review-requested:{viewer}' in query and not any(r.get('login') == viewer for r in row['reviewRequests']):
            continue
        labels = [label['name'].lower() for label in row['labels']]
        label_tokens = re.findall(r'(-?)label:((?:"[^"]*"|[^ ]+))', query)
        if any((name.strip('"').lower() in labels) == bool(negated) for negated, name in label_tokens):
            continue
        if 'draft:true' in query and not row['isDraft'] or 'draft:false' in query and row['isDraft']:
            continue
        if 'review:approved' in query and row['reviewDecision'] != 'APPROVED':
            continue
        if 'status:failure' in query and not any(c.get('conclusion') == 'FAILURE' for c in row['statusCheckRollup']):
            continue
        normalized.append(row)
    offset = int(variables.get('cursor', 0))
    count = int(variables['first'])
    page_rows = normalized[offset:offset + count]
    for row in page_rows:
        row['labels'] = {'nodes': row['labels']}
        row['reviewRequests'] = {'nodes': [{'requestedReviewer': request} for request in row['reviewRequests']]}
        states = [check.get('conclusion', check.get('state')) for check in row['statusCheckRollup']]
        check_state = 'FAILURE' if 'FAILURE' in states else 'SUCCESS' if states and all(value in ['SUCCESS','NEUTRAL','SKIPPED'] for value in states) else 'PENDING' if states else None
        row['commits'] = {'nodes': [{'commit': {'statusCheckRollup': {'state':check_state} if check_state else None}}]}
    print(json.dumps({'data': {'search': {'nodes': page_rows, 'pageInfo': {'hasNextPage': offset + count < len(normalized), 'endCursor': str(offset + count)}}}}))
elif args[:2] == ['pr', 'list']:
    print(json.dumps([row] if state.get('exists', True) else []))
elif args[:2] == ['api', 'graphql'] and 'BotInboxViewer' in query:
    print(json.dumps({'data': {'viewer': {'login': state.get('viewer', 'fixture-viewer')}}}))
elif args[:2] == ['api', 'graphql']:
    operation = query.split('query ')[-1].split('(')[0]
    if operation in state.get('failSections', []) or (state.get('pickerMutations') and operation in state.get('failCandidateReadsAfterWrites', [])):
        print(json.dumps({'errors': [{'message': 'Fixture section unavailable'}]}))
        sys.exit(0)
    if operation in state.get('wrongIdentitySections', []):
        pr['id'] = 'PR_other'
    if 'BotLabelCandidates' in query or 'BotReviewerCandidates' in query:
        if 'BotLabelCandidates' in query:
            repository = {'labels': {'nodes': state.get('labelCandidates', [{'name': 'bug', 'color': 'ff0000', 'description': 'A broken behavior'}, {'name': 'needs design', 'color': '00ff00', 'description': 'Design discussion'}]), 'pageInfo': {'hasNextPage': state.get('labelsTruncated', False)}}, 'pullRequest': {'labels': pr['labels']}}
        else:
            repository = {'assignableUsers': {'nodes': state.get('assignableUsers', [{'login': 'fixture-author', 'name': 'Author'}, {'login': 'reviewer', 'name': 'Review Person', 'avatarUrl': None}]), 'pageInfo': {'hasNextPage': state.get('reviewersTruncated', False)}}, 'pullRequest': {'author': pr['author'], 'reviewRequests': pr['reviewRequests']}}
        print(json.dumps({'data': {'repository': repository}}))
        sys.exit(0)
    page = int(variables.get('cursor') or '0')
    def connection(nodes):
        pages = state.get('pages', 1)
        return {'nodes': nodes, 'pageInfo': {'hasNextPage': page + 1 < pages, 'endCursor': str(page + 1)}}
    comment = {'reactionGroups': state.get('subjectReactions', {}).get('COMMENT_' + str(page), []), 'id': 'COMMENT_' + str(page), 'body': 'Validate negative inputs.', 'url': url + '#discussion_r1', 'author': {'login': 'reviewer'}, 'createdAt': state.get('threadAt', '2026-10-05T12:00:00Z'), 'updatedAt': '2026-10-05T12:00:00Z', 'originalCommit': {'oid': 'b' * 40}, 'diffHunk': '@@ -1 +1 @@\n-old\n+new', 'path': 'calculate.ts', 'originalLine': 1}
    thread = {'path': state.get('threadPath', 'calculate.ts'), 'line': state.get('threadLine', 2), 'diffSide': state.get('threadSide', 'RIGHT'), 'id': 'THREAD_' + str(page), 'isResolved': state.get('resolved', False), 'isOutdated': state.get('outdated', True), 'viewerCanReply': state.get('canReply', True), 'viewerCanResolve': state.get('canResolve', True), 'viewerCanUnresolve': state.get('canUnresolve', True), 'comments': {'nodes': [comment], 'pageInfo': {'hasNextPage': state.get('replyPages', False), 'endCursor': '1'}}}
    thread['comments']['nodes'].extend(state.get('postedReplies', []))
    if 'BotSetFilesViewed' in query:
        time.sleep(state.get('viewedMutationDelay', 0))
        if state.get('viewedMutationFailure'):
            print(json.dumps({'errors': [{'message': 'Fixture refused viewed update'}]}))
            sys.exit(0)
        fields = re.findall(r'f(\d+):(markFileAsViewed|unmarkFileAsViewed)\(', query)
        def save_viewed(current):
            marks = current.setdefault('viewedStates', {})
            current.setdefault('viewedMutations', []).append(variables)
            for index, action in fields:
                marks[variables['path' + index]] = 'VIEWED' if action == 'markFileAsViewed' else 'UNVIEWED'
        state = update_state(save_viewed)
        print(json.dumps({'data': {'f' + index: {'clientMutationId': None} for index, _ in fields}}))
    elif 'BotFilesViewed' in query:
        time.sleep(state.get('viewedReadDelay', 0))
        if page in state.get('viewedFailPages', []):
            print(json.dumps({'errors': [{'message': 'Fixture viewed read unavailable'}]}))
            sys.exit(0)
        nodes = state.get('viewedPages', {}).get(str(page), state.get('viewedNodes', [{'path': path, 'viewerViewedState': value} for path, value in state.get('viewedStates', {}).items()]))
        pages = state.get('viewedPageCount', 1)
        pr['files'] = {'nodes': nodes, 'pageInfo': {'hasNextPage': page + 1 < pages, 'endCursor': str(page + 1)}}
        print(json.dumps({'data': {'repository': {'pullRequest': pr}}}))
    elif 'BotReactionScope' in query:
        subject = variables['id']
        scope = state.get('subjectScope', {}).get(subject, {})
        kind = scope.get('type', 'PullRequest' if subject == pr['id'] else 'PullRequestReview' if subject.startswith('REVIEW') else 'PullRequestReviewComment' if subject.startswith('INLINE') else 'IssueComment')
        node = {'id': subject, '__typename': kind, 'pullRequest': {'id': scope.get('prId', 'PR_other' if state.get('crossPrReaction') else pr['id'])}}
        print(json.dumps({'data': {'node': None if state.get('missingReactionSubject') else node}}))
    elif 'mutation Bot' in query:
        content_mode = next((mode for operation, mode in state.get('contentMutationModes', {}).items() if operation in query), state.get('mutation', 'ok'))
        time.sleep(state.get('mutationDelay', 0))
        if content_mode == 'refuse':
            print(json.dumps({'errors': [{'message': 'Fixture refused mutation'}]}))
            sys.exit(0)
        if content_mode == 'uncertain':
            time.sleep(300)
        lifecycle = next((name for name in ['mergePullRequest','enqueuePullRequest','enablePullRequestAutoMerge','disablePullRequestAutoMerge','convertPullRequestToDraft','markPullRequestReadyForReview','closePullRequest','reopenPullRequest','updatePullRequestBranch'] if name + '(input:' in query), None)
        if lifecycle and variables['input'].get('expectedHeadOid', sha) != state.get('atomicHead', sha):
            print(json.dumps({'errors':[{'message':'Head moved. Refresh before retrying.'}]}))
            sys.exit(0)
        field = lifecycle or ('addComment' if 'BotAddComment' in query else 'addReaction' if 'BotAddReaction' in query else 'removeReaction' if 'BotRemoveReaction' in query else 'updatePullRequest' if 'BotEdit' in query else 'addPullRequestReview' if 'BotSubmitReview' in query else 'addPullRequestReviewThreadReply' if 'BotReply' in query else 'unresolveReviewThread' if 'BotUnresolve' in query else 'resolveReviewThread')
        def save_mutation(current):
            current['submitted'] = current.get('submitted', []) + [payload]
            if field == 'addComment':
                posted_id = 'COMMENT_posted_' + str(len(current['submitted']))
                current.setdefault('postedComments', []).append({**comment, 'id': posted_id, 'body': variables['input']['body'], 'reactionGroups': []})
                current.setdefault('subjectScope', {})[posted_id] = {'type': 'IssueComment', 'prId': pr['id']}
            if field in ['addReaction', 'removeReaction']:
                subject = variables['input']['subjectId']
                groups = current.setdefault('reactionGroups', []) if subject == pr['id'] else current.setdefault('subjectReactions', {}).setdefault(subject, [])
                content = variables['input']['content']
                group = next((group for group in groups if group['content'] == content), None)
                if group is None:
                    group = {'content': content, 'viewerHasReacted': False, 'reactors': {'totalCount': 0, 'nodes': []}}
                    groups.append(group)
                desired = field == 'addReaction'
                if group['viewerHasReacted'] != desired:
                    group['reactors']['totalCount'] += 1 if desired else -1
                    group['viewerHasReacted'] = desired
                viewer = current.get('viewer', 'fixture-viewer')
                actors = [actor for actor in group['reactors'].get('nodes', []) if actor.get('login') != viewer]
                if desired: actors.insert(0, {'login': viewer})
                group['reactors']['nodes'] = actors[:10]
            if field in ['resolveReviewThread', 'unresolveReviewThread']:
                current['resolved'] = field == 'resolveReviewThread'
                for row in current.get('threads', []):
                    if row['id'] == variables['input']['threadId']: row['isResolved'] = current['resolved']
            if field == 'addPullRequestReviewThreadReply':
                reply = {**comment, 'id': 'COMMENT_saved_' + str(len(current['submitted'])), 'body': variables['input']['body']}
                if 'threads' in current:
                    for row in current['threads']:
                        if row['id'] == variables['input']['pullRequestReviewThreadId']: row['comments']['nodes'].append(reply)
                else:
                    current.setdefault('postedReplies', []).append(reply)
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
        if content_mode == 'acceptThenUncertain':
            print('Connection lost after acceptance', file=sys.stderr)
            sys.exit(1)
        if field == 'addComment':
            print(json.dumps({'data': {'addComment': {'commentEdge': {'node': {'id': state['postedComments'][-1]['id']}}}}}))
            sys.exit(0)
        child = 'mergeQueueEntry' if field == 'enqueuePullRequest' else 'pullRequest' if lifecycle or field == 'updatePullRequest' else 'pullRequestReview' if field == 'addPullRequestReview' else 'comment' if field == 'addPullRequestReviewThreadReply' else 'reaction' if field in ['addReaction', 'removeReaction'] else 'thread'
        print(json.dumps({'data': {field: {child: {'id': 'REVIEW_saved' if child == 'pullRequestReview' else 'COMMENT_saved' if child == 'comment' else pr['id'] if lifecycle or field == 'updatePullRequest' else 'REACTION_saved' if child == 'reaction' else variables['input']['threadId']}}}}))
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
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'reviewThreads': connection(state.get('threads', [thread]))}}}}))
    elif 'BotReviewReplies' in query:
        print(json.dumps({'data': {'node': {'id': variables['id'], 'pullRequest': {'id': 'PR_other' if state.get('crossPrReply') else pr['id']}, 'comments': {'nodes': [{**comment, 'id': 'REPLY_' + str(page)}], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}}}))
    elif 'BotReviewConversation' in query or 'BotReviewSummaries' in query:
        field = 'reviews' if 'BotReviewSummaries' in query else 'comments'
        subject_id = field.upper() + '_' + str(page)
        rows = state.get('reviewSummaries' if field == 'reviews' else 'conversationComments', [{**comment, 'id': subject_id, 'reactionGroups': state.get('subjectReactions', {}).get(subject_id, []), 'state': 'CHANGES_REQUESTED', 'createdAt': state.get('reviewAt' if field == 'reviews' else 'commentAt', comment['createdAt'])}])
        if field == 'comments': rows = rows + [{**row, 'reactionGroups': state.get('subjectReactions', {}).get(row['id'], row.get('reactionGroups', []))} for row in state.get('postedComments', [])]
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, field: connection(rows)}}}}))
    elif 'BotReviewCommits' in query:
        commits = state.get('commitPages', {}).get(str(page), state.get('commits', [{'oid': 'c' * 40, 'messageHeadline': 'Validate input', 'committedDate': '2026-10-03T12:00:00Z', 'author': {'name': 'Contributor', 'user': {'login': 'contributor'}}}]))
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'commits': connection([{'commit': commit} for commit in commits])}}}}))
    elif 'BotReviewChecks' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': {'id': pr['id'], 'headRefOid': sha, 'statusCheckRollup': {'contexts': connection([{'__typename': 'CheckRun', 'name': 'unit tests', 'status': 'COMPLETED', 'conclusion': state.get('checkConclusion', 'FAILURE'), 'detailsUrl': url + '/checks'}])}}}}}))
    elif 'BotReviewThread' in query:
        print(json.dumps({'data': {'node': {**next((row for row in state.get('threads', []) if row['id'] == variables['id']), thread), 'id': variables['id'], 'pullRequest': {'id': 'PR_other' if state.get('crossPrThread') else pr['id']}}}}))
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
elif args[:1] == ['api'] and '/commits/' in args[1]:
    oid = args[1].split('/commits/')[1].split('?')[0]
    page = int(args[1].split('page=')[-1]) if '?per_page=' in args[1] else 1
    commit_mode = state.get('commitModes', {}).get(oid, 'ok')
    time.sleep(state.get('commitDelays', {}).get(oid, 0))
    if commit_mode == 'error' or page in state.get('failCommitPages', []):
        print('Fixture commit unavailable', file=sys.stderr)
        sys.exit(1)
    if commit_mode == 'omitted':
        print(json.dumps({'sha': oid}))
    else:
        files = state.get('commitFilePages', {}).get(oid, {}).get(str(page), state.get('commitFiles', {}).get(oid, []))
        print(json.dumps({'sha': oid, 'parents': [{'sha': parent} for parent in state.get('commitParents', {}).get(oid, ['b' * 40])], 'files': files}))
elif args[:1] == ['api'] and '/compare/' in args[1]:
    if state.get('failCompare'):
        print('Fixture comparison unavailable', file=sys.stderr)
        sys.exit(1)
    print(json.dumps({'merge_base_commit': {'sha': state.get('compareMergeBase', 'b' * 40)}}))
elif args[:1] == ['api'] and '/contents/' in args[1]:
    path, _, ref = args[1].split('/contents/')[1].partition('?ref=')
    key = ref + ':' + unquote(path)
    value = state.get('fileContents', {}).get(key)
    if value is None:
        print('Fixture file contents unavailable', file=sys.stderr)
        sys.exit(1)
    if isinstance(value, str):
        content = value.encode('utf-8')
        value = {'type': 'file', 'encoding': 'base64', 'size': len(content), 'content': base64.b64encode(content).decode('ascii')}
    print(json.dumps(value))
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
