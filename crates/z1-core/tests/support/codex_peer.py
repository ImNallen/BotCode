#!/usr/bin/env python3
import json, os, pathlib, sys, time, subprocess
root = pathlib.Path(__file__).parent
if len(sys.argv) > 1 and sys.argv[1] == 'exec':
    prompt = sys.stdin.read()
    with (root / 'naming.jsonl').open('a') as log:
        log.write(json.dumps({'args': sys.argv[1:], 'prompt': prompt, 'cwd': os.getcwd()}) + '\n')
    (root / 'naming.pid').write_text(str(os.getpid()))
    if (root / 'naming_descendant').exists():
        child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(90)'])
        (root / 'naming_child.pid').write_text(str(child.pid))
    (root / 'naming_ready').touch()
    if (root / 'naming_stall').exists():
        while True:
            time.sleep(1)
    if (root / 'naming_delay').exists():
        time.sleep(float((root / 'naming_delay').read_text()))
    output = root / 'naming_output'
    if not output.exists():
        sys.exit(1)
    pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1]).write_text(output.read_text())
    sys.exit(0)
log = root / 'calls.jsonl'
(root / 'pid').write_text(str(os.getpid()))
active = None
current_thread = None
callbacks = set()
def emit(value):
    print(json.dumps(value), flush=True)
def result(request, value):
    emit({'id': request['id'], 'result': value})
def event(method, params):
    emit({'method': method, 'params': params})
def finish(status='completed'):
    event('turn/completed', {'threadId': current_thread, 'turn': {'id': active, 'status': status, 'items': []}})
for line in sys.stdin:
    request = json.loads(line)
    with log.open('a') as output:
        output.write(json.dumps(request) + '\n')
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        result(request, {'userAgent': 'Z1 fixture'})
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
    elif method in ('thread/start', 'thread/resume'):
        current_thread = params['threadId'] if method == 'thread/resume' else 'native-thread-' + str(request['id'])
        result(request, {'thread': {'id': current_thread, 'turns': []}})
        if (root / 'stall').exists():
            while True:
                time.sleep(1)
    elif method == 'turn/start':
        prompt = params['input'][0]['text']
        if prompt == 'lose':
            sys.exit(0)
        active = 'native-' + params['clientUserMessageId']
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
                    emit({'id': callback, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'same-parent-item', 'command': None if prompt == 'missing-command' else 'echo ' + callback, 'cwd': '/fixture', 'reason': 'Fixture approval'}})
        elif prompt == 'hold':
            pass
        elif prompt == 'late-approval':
            time.sleep(0.5)
            callbacks = {'late-route'}
            emit({'id': 'late-route', 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': current_thread, 'turnId': active, 'itemId': 'late-item', 'command': 'echo late', 'cwd': '/fixture', 'reason': 'Fixture approval'}})
        elif prompt == 'descendant':
            child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
            pid_file = root / 'descendant.pid.tmp'
            pid_file.write_text(str(child.pid))
            pid_file.replace(root / 'descendant.pid')
            time.sleep(0.15)
        else:
            event('item/agentMessage/delta', {'threadId': current_thread, 'turnId': active, 'itemId': 'reply', 'delta': 'fixture reply'})
            event('item/completed', {'threadId': current_thread, 'turnId': active, 'item': {'id': 'reply', 'type': 'agentMessage', 'text': 'fixture reply'}})
            finish()
    elif method == 'turn/interrupt':
        result(request, {})
        finish('interrupted')
    elif method is None and request.get('id') in callbacks:
        callbacks.remove(request['id'])
        if not callbacks:
            finish()
