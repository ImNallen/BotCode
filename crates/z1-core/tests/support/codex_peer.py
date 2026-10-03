#!/usr/bin/env python3
import json, os, pathlib, sys, time, subprocess
root = pathlib.Path(__file__).parent
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
        elif prompt == 'descendant':
            child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
            (root / 'descendant.pid').write_text(str(child.pid))
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
