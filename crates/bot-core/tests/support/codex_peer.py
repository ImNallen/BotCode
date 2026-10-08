#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time, subprocess
root = pathlib.Path(__file__).parent
def publish(path, text):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    temporary.replace(path)
if len(sys.argv) > 1 and sys.argv[1] == 'exec':
    prompt = sys.stdin.read()
    schema = json.loads(pathlib.Path(sys.argv[sys.argv.index('--output-schema') + 1]).read_text())
    fields = schema['properties']
    kind = 'commit' if 'subject' in fields else 'pr' if 'title' in fields else 'naming'
    with (root / f'{kind}.jsonl').open('a') as log:
        log.write(json.dumps({'args': sys.argv[1:], 'prompt': prompt, 'cwd': os.getcwd()}) + '\n')
    publish(root / f'{kind}.pid', str(os.getpid()))
    if (root / f'{kind}_descendant').exists():
        child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(90)'])
        publish(root / f'{kind}_child.pid', str(child.pid))
    (root / f'{kind}_ready').touch()
    if (root / f'{kind}_stall').exists():
        while True:
            time.sleep(1)
    if (root / f'{kind}_hold').exists():
        deadline = time.time() + 10
        while not (root / f'{kind}_release').exists() and time.time() < deadline:
            time.sleep(0.01)
    if (root / f'{kind}_delay').exists():
        time.sleep(float((root / f'{kind}_delay').read_text()))
    output = root / f'{kind}_output'
    if not output.exists():
        sys.exit(1)
    pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1]).write_text(output.read_text())
    sys.exit(0)
log = root / 'calls.jsonl'
(root / 'pid').write_text(str(os.getpid()))
with (root / 'launches.jsonl').open('a') as launches:
    launches.write(json.dumps({'time': time.time(), 'pid': os.getpid()}) + '\n')
print(f'fixture stderr: started {os.getpid()}', file=sys.stderr, flush=True)
crash_on_launch = root / 'crash_on_launch'
if crash_on_launch.exists():
    left = int(crash_on_launch.read_text())
    print(f'fixture stderr: refusing to start ({left} left)', file=sys.stderr, flush=True)
    if left > 1:
        crash_on_launch.write_text(str(left - 1))
    else:
        crash_on_launch.unlink()
    sys.exit(3)
active = None
current_thread = None
callbacks = set()
approval_expected = None
session_grants = set()
def emit(value):
    print(json.dumps(value), flush=True)
def result(request, value):
    emit({'id': request['id'], 'result': value})
def event(method, params):
    emit({'method': method, 'params': params})
def finish(status='completed'):
    event('turn/completed', {'threadId': current_thread, 'turn': {'id': active, 'status': status, 'items': []}})
def limits_update(snapshot):
    event('account/rateLimits/updated', {'rateLimits': snapshot})
codex_limits = {'limitId': 'codex', 'planType': 'pro', 'primary': {'usedPercent': 44, 'windowDurationMins': 10080, 'resetsAt': 1791580401}, 'secondary': None}
other_limits = {'limitId': 'base_model_inference', 'planType': 'pro', 'primary': {'usedPercent': 99, 'windowDurationMins': 300, 'resetsAt': 1791500000}, 'secondary': None}
def token_usage(last, total):
    breakdown = lambda n: {'totalTokens': n, 'inputTokens': n, 'cachedInputTokens': 0, 'outputTokens': 0, 'reasoningOutputTokens': 0}
    event('thread/tokenUsage/updated', {'threadId': current_thread, 'turnId': active, 'tokenUsage': {'last': breakdown(last), 'total': breakdown(total), 'modelContextWindow': 258400}})
for line in sys.stdin:
    request = json.loads(line)
    with log.open('a') as output:
        output.write(json.dumps(request) + '\n')
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        result(request, {'userAgent': 'Bot Code fixture'})
    elif method == 'collaborationMode/list':
        if (root / 'collaboration').exists():
            result(request, {'data': [{'name': 'Plan', 'mode': 'plan', 'model': None, 'reasoning_effort': 'medium'}, {'name': 'Default', 'mode': 'default', 'model': None, 'reasoning_effort': None}]})
        elif (root / 'collaboration_malformed').exists():
            result(request, {'data': [{'mode': 'future', 'reasoning_effort': None}]})
        else:
            emit({'id': request['id'], 'error': {'code': -32601, 'message': 'Method not found'}})
    elif method == 'model/list':
        if (root / 'models_error').exists():
            emit({'id': request['id'], 'error': {'message': 'Catalog unavailable'}})
        elif (root / 'models_removed').exists():
            result(request, {'data': [], 'nextCursor': None})
        elif params.get('cursor') is None:
            result(request, {'data': [
                {'model': 'model-one', 'displayName': 'Model One', 'description': 'Default model', 'isDefault': True, 'hidden': False,
                 'defaultReasoningEffort': 'low', 'supportedReasoningEfforts': [
                     {'reasoningEffort': 'low', 'description': 'Low'}, {'reasoningEffort': 'ultra', 'description': 'Ultra'}]},
                {'model': 'hidden-model', 'displayName': 'Hidden', 'description': 'Hidden', 'isDefault': False, 'hidden': True,
                 'defaultReasoningEffort': 'low', 'supportedReasoningEfforts': []}
            ], 'nextCursor': 'second'})
        else:
            result(request, {'data': [{'model': 'model-two', 'displayName': 'Model Two', 'description': 'Another model',
                'isDefault': False, 'hidden': False, 'defaultReasoningEffort': 'medium',
                'supportedReasoningEfforts': [{'reasoningEffort': 'medium', 'description': 'Medium'}]}], 'nextCursor': None})
    elif method == 'account/read':
        if (root / 'account_apikey').exists():
            result(request, {'account': {'type': 'apiKey'}, 'requiresOpenaiAuth': True})
        elif (root / 'account_none').exists():
            result(request, {'account': None, 'requiresOpenaiAuth': True})
        else:
            result(request, {'account': {'type': 'chatgpt', 'email': 'fixture@example.invalid', 'planType': 'pro'}, 'requiresOpenaiAuth': True})
    elif method == 'account/rateLimits/read':
        if (root / 'limits_error').exists():
            emit({'id': request['id'], 'error': {'message': 'Usage service unavailable'}})
        else:
            result(request, {'rateLimits': codex_limits, 'rateLimitsByLimitId': {'codex': codex_limits, 'base_model_inference': other_limits}})
    elif method in ('thread/start', 'thread/resume'):
        current_thread = params['threadId'] if method == 'thread/resume' else 'native-thread-' + str(request['id'])
        history = json.loads((root / 'history.json').read_text()) if (root / 'history.json').exists() else []
        result(request, {'thread': {'id': current_thread, 'turns': history}})
        if (root / 'stall').exists():
            while True:
                time.sleep(1)
    elif method == 'turn/start':
        prompt = params['input'][0].get('text', '')
        if prompt == 'lose':
            sys.exit(0)
        active = 'native-' + params['clientUserMessageId']
        if prompt == 'crash-before-ack':
            print(f'fixture stderr: panic before ack {active}', file=sys.stderr, flush=True)
            os.kill(os.getpid(), signal.SIGKILL)
        if prompt != 'late-response':
            result(request, {'turn': {'id': active, 'status': 'inProgress', 'items': []}})
        event('turn/started', {'threadId': current_thread, 'turn': {'id': active}})
        if prompt in ('approval', 'missing-command', 'late-file'):
            if prompt == 'late-file':
                callbacks = {'file-route'}
                emit({'id': 'file-route', 'method': 'item/fileChange/requestApproval', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'file-item', 'reason': 'Review a fixture change'}})
                event('item/started', {'threadId': current_thread, 'turnId': active, 'item': {'id': 'file-item', 'type': 'fileChange', 'status': 'inProgress', 'changes': [{'path': 'test.txt', 'diff': '+fixture change'}]}})
            else:
                callbacks = {'route-one', 'route-two'}
                for callback in sorted(callbacks):
                    emit({'id': callback, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'same-parent-item', 'command': None if prompt == 'missing-command' else 'echo ' + callback, 'cwd': '/fixture', 'reason': None if prompt == 'missing-command' else 'Fixture approval'}})
        elif prompt.startswith('approval-kind-'):
            scenario = prompt.removeprefix('approval-kind-')
            target = {'threadId': current_thread, 'turnId': active, 'itemId': 'kind-item'}
            approval_expected = None
            if scenario in ('command-session', 'command-changed'):
                params = {**target, 'command': 'echo changed' if scenario.endswith('changed') else 'echo session', 'cwd': '/fixture', 'reason': 'Review this command'}
                method = 'item/commandExecution/requestApproval'
                approval_expected = {'decision': 'acceptForSession'} if scenario == 'command-session' else {'decision': 'accept'}
            elif scenario == 'reason-only':
                method = 'item/commandExecution/requestApproval'
                params = {**target, 'command': None, 'reason': 'Run outside the read-only sandbox', 'cwd': '/fixture'}
                approval_expected = {'decision': 'accept'}
            elif scenario == 'managed-network':
                method = 'item/commandExecution/requestApproval'
                params = {**target, 'command': None, 'cwd': '/fixture', 'reason': 'Contact the package registry', 'networkApprovalContext': {'host': 'registry.npmjs.org', 'protocol': 'https'}}
                approval_expected = {'decision': 'accept'}
            elif scenario in ('file-root', 'file-root-late', 'file-no-details'):
                method = 'item/fileChange/requestApproval'
                params = {**target, 'reason': None if scenario == 'file-no-details' else 'The tool needs write access outside the workspace', 'grantRoot': None if scenario == 'file-no-details' else '/fixture/external'}
                approval_expected = {'decision': 'decline'} if scenario == 'file-no-details' else {'decision': 'accept'}
            elif scenario == 'file-change':
                method = 'item/fileChange/requestApproval'
                params = {**target, 'reason': 'Review this file edit', 'grantRoot': '/fixture'}
                event('item/started', {**target, 'item': {'id': 'kind-item', 'type': 'fileChange', 'status': 'inProgress', 'changes': [{'path': 'test.txt', 'diff': '@@ -1 +1 @@\n-old\n+new'}]}})
                approval_expected = {'decision': 'accept'}
            elif scenario in ('permission-network', 'permission-filesystem', 'permission-extensions'):
                method = 'item/permissions/requestApproval'
                permissions = {'network': {'enabled': True}, 'fileSystem': None} if scenario == 'permission-network' else {'network': None, 'fileSystem': {'read': ['/fixture/shared'], 'write': ['/fixture/output'], 'entries': [{'path': {'type': 'glob_pattern', 'pattern': '/fixture/logs/**'}, 'access': 'write'}]}}
                if scenario == 'permission-extensions':
                    permissions['futurePermission'] = {'destination': 'explicitly-reviewed'}
                params = {**target, 'cwd': '/fixture', 'environmentId': None, 'reason': 'Grant the requested access', 'permissions': permissions}
                approval_expected = {'permissions': permissions, 'scope': 'turn'}
            elif scenario.startswith('mcp-'):
                method = 'mcpServer/elicitation/request'
                params = {'threadId': current_thread, 'turnId': None if scenario == 'mcp-null-turn' else active, 'serverName': 'fixture-server', 'mode': 'form', '_meta': {'app_name': 'Fixture App'}, 'message': 'Allow ChatGPT to use Fixture App?', 'requestedSchema': {'type': 'object', 'properties': {}, 'required': []}}
                approval_expected = {'action': 'accept', 'content': {}}
                if scenario == 'mcp-session':
                    params['_meta']['persist'] = ['session']
                    approval_expected = {'action': 'accept', '_meta': {'persist': 'session'}, 'content': {}}
                elif scenario == 'mcp-always':
                    params['requestedSchema'] = {'properties': {'persist': {'type': 'boolean', 'title': 'Always allow'}, 'choice': {'oneOf': [{'const': 'once', 'title': 'Approve once'}, {'const': 'always', 'title': 'Always allow'}]}}, 'required': ['persist', 'choice']}
                    approval_expected = {'action': 'accept', '_meta': {'persist': 'always'}, 'content': {'persist': True, 'choice': 'always'}}
                elif scenario == 'mcp-optional':
                    params['mode'] = 'openai/form'
                    params['requestedSchema'] = {'properties': {'notes': {'type': 'string'}, 'approved': {'type': 'boolean', 'default': True}}, 'required': ['approved']}
                    approval_expected = {'action': 'accept', 'content': {'approved': True}}
                elif scenario == 'mcp-malformed':
                    params['requestedSchema'] = {'properties': {'choice': {'enum': [7]}}, 'required': ['choice']}
                    approval_expected = {'action': 'decline'}
                elif scenario == 'mcp-null-schema':
                    params['requestedSchema'] = None
                    approval_expected = {'action': 'decline'}
                elif scenario == 'mcp-required':
                    params['requestedSchema'] = {'properties': {'email': {'type': 'string'}}, 'required': ['email']}
                    approval_expected = {'action': 'decline'}
                elif scenario == 'mcp-url':
                    params['mode'] = 'url'
                    params['url'] = 'https://example.invalid/auth'
                    params['elicitationId'] = 'elicitation-1'
                    params.pop('requestedSchema')
                    approval_expected = {'action': 'decline'}
                elif scenario == 'mcp-camel-form':
                    params['mode'] = 'openaiForm'
            elif scenario.startswith('legacy-'):
                params = {'conversationId': current_thread, 'callId': 'legacy-item', 'reason': 'Review legacy action'}
                if scenario == 'legacy-command':
                    method = 'execCommandApproval'
                    params.update({'command': ['echo', 'legacy command'], 'cwd': '/fixture', 'parsedCmd': [], 'approvalId': None})
                else:
                    method = 'applyPatchApproval'
                    params.update({'fileChanges': {'test.txt': {'type': 'update', 'unified_diff': '@@ -1 +1 @@\n-old\n+new', 'move_path': None}}, 'grantRoot': None})
                    if scenario == 'legacy-file-root':
                        params.update({'fileChanges': {}, 'grantRoot': '/fixture/external'})
                    elif scenario == 'legacy-file-reason':
                        params.update({'fileChanges': {}, 'reason': 'Legacy patch needs external access'})
                approval_expected = {'decision': 'approved'}
            elif scenario in ('token-refresh', 'tool-call'):
                method = 'account/chatgptAuthTokens/refresh' if scenario == 'token-refresh' else 'item/tool/call'
                params = {'reason': 'unauthorized', 'previousAccountId': None} if scenario == 'token-refresh' else {**target, 'tool': 'fixture-tool', 'arguments': {}}
                approval_expected = {'errorCode': -32601 if scenario == 'token-refresh' else -32602}
            elif scenario == 'malformed':
                method = 'item/permissions/requestApproval'
                params = {**target, 'turnId': 123, 'permissions': {'network': {'enabled': True}}}
                approval_expected = {'errorCode': -32602}
            elif scenario == 'stale-turn':
                method = 'item/permissions/requestApproval'
                params = {**target, 'turnId': 'stale-turn', 'permissions': {'network': {'enabled': True}}, 'reason': 'Must be refused'}
                approval_expected = {'errorCode': -32601}
            else:
                raise AssertionError(scenario)
            grant_key = (current_thread, method, json.dumps({key: value for key, value in params.items() if key not in ('turnId', 'itemId')}, sort_keys=True))
            if grant_key in session_grants:
                finish()
            else:
                callbacks = {'approval-kind-route'}
                emit({'id': 'approval-kind-route', 'method': method, 'params': params})
                if scenario == 'file-root-late':
                    release = root / 'file_patch_release'
                    deadline = time.time() + 10
                    while not release.exists() and time.time() < deadline:
                        time.sleep(0.01)
                    event('item/started', {**target, 'item': {'id': 'kind-item', 'type': 'fileChange', 'status': 'inProgress', 'changes': [{'path': '/fixture/external/test.txt', 'diff': '+exact later patch'}]}})
        elif prompt == 'propose-plan':
            plan = {'id': 'proposed-plan', 'type': 'plan', 'text': '# Fixture plan\n\nImplement the requested composer workflow.'}
            event('item/started', {'threadId': current_thread, 'turnId': active, 'item': {'id': plan['id'], 'type': 'plan', 'text': ''}})
            event('item/plan/delta', {'threadId': current_thread, 'turnId': active, 'itemId': plan['id'], 'delta': '# Fixture plan\n\n'})
            event('item/plan/delta', {'threadId': current_thread, 'turnId': active, 'itemId': plan['id'], 'delta': 'Implement the requested composer workflow.'})
            time.sleep(0.15)
            event('item/completed', {'threadId': current_thread, 'turnId': active, 'item': plan})
            (root / 'history.json').write_text(json.dumps([{'id': active, 'status': 'completed', 'items': [plan]}]))
            finish()
        elif prompt == 'native-items':
            def item(method, value):
                event(method, {'threadId': current_thread, 'turnId': active, 'item': value})
            def reasoning(method, item_id, **fields):
                event('item/reasoning/' + method, {'threadId': current_thread, 'turnId': active, 'itemId': item_id, **fields})
            search = {'type': 'webSearch', 'id': 'exec-af1cec6b-7b06-458e-8d44-f38131318601', 'query': '', 'action': None, 'results': None}
            item('item/started', search)
            item('item/completed', {**search, 'query': 'latest Rust release site:blog.rust-lang.org', 'action': {'type': 'search', 'query': 'latest Rust release site:blog.rust-lang.org', 'queries': None}, 'results': [{'type': 'text_result', 'domain': 'blog.rust-lang.org', 'ref_id': 'turn0search0', 'title': 'Announcing Rust 1.97.0 | Rust Blog', 'url': 'https://blog.rust-lang.org/2026/07/09/Rust-1.97.0/'}]})
            mcp = {'type': 'mcpToolCall', 'id': 'exec-0e668882-3b63-455d-8185-6ddafa10e7cd', 'server': 'node_repl', 'tool': 'js', 'status': 'inProgress', 'arguments': {'code': 'nodeRepl.write(6*7)', 'title': 'Evaluate 6 × 7'}, 'appContext': None, 'mcpAppUi': None, 'pluginId': None, 'readOnlyHint': True, 'result': None, 'error': None, 'durationMs': None}
            item('item/started', mcp)
            summary_id = 'rs_0612991cf91e8829016ac65f87221c87d2beaa39e7ea874690'
            item('item/started', {'type': 'reasoning', 'id': summary_id, 'summary': [], 'content': []})
            reasoning('summaryPartAdded', summary_id, summaryIndex=0)
            reasoning('summaryTextDelta', summary_id, delta='**Calculating a math expression**\n\nI', summaryIndex=0)
            reasoning('summaryTextDelta', summary_id, delta=' need to compute floor(999/3).', summaryIndex=0)
            reasoning('summaryPartAdded', summary_id, summaryIndex=1)
            reasoning('summaryTextDelta', summary_id, delta='Then add 333.', summaryIndex=1)
            release = root / 'native_items_release'
            deadline = time.time() + 10
            while not release.exists() and time.time() < deadline:
                time.sleep(0.01)
            item('item/completed', {**mcp, 'status': 'completed', 'result': {'content': [{'type': 'text', 'text': '42'}], 'structuredContent': None, '_meta': {'codex/nodeReplExecutionDurationMs': 0}}, 'durationMs': 56})
            item('item/completed', {'type': 'reasoning', 'id': summary_id, 'summary': ['**Calculating a math expression**\n\nI need to compute floor(999/3).', 'Then add 333.'], 'content': []})
            raw_id = 'rs_0054cc89d9ce4db0016ac65f68c6848191881bf3f88b094734'
            item('item/started', {'type': 'reasoning', 'id': raw_id, 'summary': [], 'content': []})
            reasoning('textDelta', raw_id, delta='Raw thought', contentIndex=0)
            item('item/completed', {'type': 'reasoning', 'id': raw_id, 'summary': [], 'content': []})
            compaction = {'type': 'contextCompaction', 'id': '01a116e4-b2c0-7723-a84a-19dc76d47a0e'}
            item('item/started', compaction)
            item('item/completed', compaction)
            for value in [
                {'type': 'dynamicToolCall', 'id': 'dynamic-1', 'namespace': None, 'tool': 'lookup', 'arguments': {}, 'status': 'failed', 'contentItems': None, 'success': False, 'durationMs': 3},
                {'type': 'collabAgentToolCall', 'id': 'collab-1', 'tool': 'spawnAgent', 'status': 'interrupted', 'senderThreadId': current_thread, 'receiverThreadIds': ['child-thread'], 'prompt': 'Review the diff', 'model': None, 'reasoningEffort': None, 'agentsStates': {}},
                {'type': 'subAgentActivity', 'id': 'sub-1', 'kind': 'started', 'agentThreadId': 'child-thread', 'agentPath': '/root/reviewer'},
                {'type': 'imageView', 'id': 'view-1', 'path': '/fixture/screen.png'},
                {'type': 'imageGeneration', 'id': 'gen-1', 'status': 'completed', 'revisedPrompt': None, 'result': '', 'failure': None},
                {'type': 'sleep', 'id': 'sleep-1', 'durationMs': 1500},
                {'type': 'enteredReviewMode', 'id': 'review-1', 'review': 'current changes'},
                {'type': 'hookPrompt', 'id': 'hook-1', 'fragments': [{'text': 'Run the linter.', 'hookRunId': 'h1'}, {'text': 'Then the tests.', 'hookRunId': 'h2'}]},
                {'type': 'functionCallOutput', 'id': 'output-1', 'name': 'shell', 'namespace': None, 'output': 'ok'},
                {**mcp, 'id': 'computer-1', 'server': 'computer-use', 'tool': 'click', 'status': 'completed', 'arguments': {'app': '  Safari '}, 'result': {'content': [{'type': 'image', 'data': ''}, {'type': 'text', 'text': 'clicked'}, {'type': 'text', 'text': 'done'}], 'structuredContent': None, '_meta': None}, 'durationMs': 9},
                {**mcp, 'id': 'github-1', 'server': 'github', 'tool': 'search_issues', 'status': 'failed', 'arguments': {}, 'error': {'message': 'rate limited'}},
                {'type': 'futureThing', 'id': 'future-1'},
            ]:
                item('item/completed', value)
            finish()
        elif prompt in ('ask-plan', 'ask-plan-empty-options'):
            callbacks = {'question-route'}
            emit({'id': 'question-route', 'method': 'item/tool/requestUserInput', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'question-item', 'isBlocking': True, 'autoResolutionMs': None, 'questions': [{'id': 'scope', 'header': 'Scope', 'question': 'Which workflow should be implemented?', 'isOther': True, 'isSecret': False, 'options': [{'label': 'Composer', 'description': 'Implement the composer'}]}, {'id': 'notes', 'header': 'Notes', 'question': 'Any constraints?', 'isOther': False, 'isSecret': False, 'options': [] if prompt == 'ask-plan-empty-options' else None}]}})
        elif prompt == 'hold':
            pass
        elif prompt == 'crash':
            print(f'fixture stderr: panic in turn {active}', file=sys.stderr, flush=True)
            os.kill(os.getpid(), signal.SIGKILL)
        elif prompt == 'late-approval':
            time.sleep(0.5)
            callbacks = {'late-route'}
            emit({'id': 'late-route', 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'late-item', 'command': 'echo late', 'cwd': '/fixture', 'reason': None if prompt == 'missing-command' else 'Fixture approval'}})
        elif prompt == 'descendant':
            child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
            pid_file = root / 'descendant.pid.tmp'
            pid_file.write_text(str(child.pid))
            pid_file.replace(root / 'descendant.pid')
            time.sleep(0.15)
        else:
            if prompt == 'usage':
                token_usage(20575, 41150)
                tick = {'limitId': 'codex', 'primary': {'usedPercent': 47}, 'secondary': {'usedPercent': 3, 'windowDurationMins': 300, 'resetsAt': 1791470000}, 'planType': None}
                limits_update(tick)
                limits_update(tick)
                limits_update({'limitId': 'base_model_inference', 'primary': {'usedPercent': 99}})
                limits_update({'limitId': 'codex', 'primary': None, 'secondary': None, 'planType': None})
                token_usage(0, 41150)
            event('item/agentMessage/delta', {'threadId': current_thread, 'turnId': active, 'itemId': 'reply', 'delta': 'fixture reply'})
            event('item/completed', {'threadId': current_thread, 'turnId': active, 'item': {'id': 'reply', 'type': 'agentMessage', 'text': 'fixture reply'}})
            finish()
    elif method == 'turn/steer':
        prompt = params['input'][0].get('text', '')
        if prompt == 'lose-steer':
            sys.exit(0)
        elif prompt == 'no-response-steer':
            pass
        elif prompt == 'reject-steer':
            emit({'id': request['id'], 'error': {'message': 'Steer refused'}})
        elif prompt == 'completion-without-user':
            finish()
            emit({'id': request['id'], 'error': {'message': 'Turn already ended'}})
        elif prompt == 'wrong-target-ack':
            result(request, {'turnId': 'wrong-target'})
        elif prompt == 'wrong-target-event':
            item = {'type': 'userMessage', 'id': 'wrong-turn-message', 'clientId': params['clientUserMessageId'], 'content': params['input']}
            event('item/completed', {'threadId': current_thread, 'turnId': 'wrong-target', 'item': item})
            result(request, {'turnId': 'wrong-target'})
        else:
            item = {'type': 'userMessage', 'id': 'native-message-' + params['clientUserMessageId'], 'clientId': params['clientUserMessageId'], 'content': params['input']}
            event('item/started', {'threadId': current_thread, 'turnId': active, 'item': item})
            event('item/completed', {'threadId': current_thread, 'turnId': active, 'item': item})
            history_file = root / 'history.json'
            history = json.loads(history_file.read_text()) if history_file.exists() else [{'id': active, 'status': 'completed', 'items': [{'type': 'userMessage', 'id': 'original-message', 'clientId': active.removeprefix('native-')}] }]
            history[0]['items'].append(item)
            history_file.write_text(json.dumps(history))
            if prompt == 'event-before-error':
                emit({'id': request['id'], 'error': {'message': 'Reply lost after userMessage'}})
            else:
                result(request, {'turnId': active})
    elif method == 'turn/interrupt':
        result(request, {})
        finish('interrupted')
    elif method is None and request.get('id') in callbacks:
        if request['id'] == 'approval-kind-route':
            expected_file = root / 'approval_expected.json'
            expected = json.loads(expected_file.read_text()) if expected_file.exists() else approval_expected
            actual = {'errorCode': request.get('error', {}).get('code')} if 'errorCode' in expected else request.get('result')
            if actual != expected:
                (root / 'approval_mismatch.json').write_text(json.dumps({'expected': expected, 'actual': actual}))
                finish('failed')
                callbacks.clear()
                continue
            response = request.get('result', {})
            if response.get('decision') in ('acceptForSession', 'approved_for_session') or response.get('scope') == 'session' or response.get('_meta', {}).get('persist') in ('session', 'always'):
                session_grants.add(grant_key)
        callbacks.remove(request['id'])
        if not callbacks:
            finish()
