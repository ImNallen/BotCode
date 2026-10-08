#!/usr/bin/env python3
import json
import os
import pathlib
import socket
import sys
import threading
import time

root = pathlib.Path(__file__).parent
(root / 'pid').write_text(str(os.getpid()))
output_lock = threading.Lock()
configs = {}
pending = {}
active = {}
counter = 0


def emit(frame):
    with output_lock:
        print(json.dumps(frame), flush=True)


def log(name, value):
    with output_lock:
        with (root / name).open('a') as file:
            file.write(json.dumps(value) + '\n')


def finish(run, status='completed'):
    emit({'method': 'turn/completed', 'params': {
        'threadId': run['thread'], 'turn': {'id': run['turn'], 'status': status, 'items': []}}})


def params_for(run, step):
    params = {'threadId': run['thread'], 'turnId': run['turn'],
              'callId': step.get('callId', f"call-{run['turn']}-{run['index']}"),
              'namespace': None, 'tool': step['name'], 'arguments': step.get('arguments', {})}
    params.update(step.get('override', {}))
    for field in step.get('omit', []):
        params.pop(field, None)
    return params


def next_dynamic(run):
    if run['index'] == len(run['steps']):
        if run['finish']:
            finish(run)
        return
    step = run['steps'][run['index']]
    route = step.get('requestId', f"route-{run['turn']}-{run['index']}")
    pending[route] = run
    emit({'id': route, 'method': 'item/tool/call', 'params': params_for(run, step)})
    if run.get('stale'):
        run['stale'] = False
        emit({'method': 'turn/completed', 'params': {'threadId': run['thread'],
            'turn': {'id': 'old-unseen-turn', 'status': 'completed', 'items': []}}})


def mcp_run(run):
    time.sleep(0.04)
    config = configs[run['thread']]
    env = config['env']
    for index, step in enumerate(run['steps']):
        run['index'] = index
        params = params_for(run, step)
        request = {'credential': env['BOT_CODE_AGENT_TOKEN'], 'operation': {
            'operation': 'call', 'caller': {'native_thread': params['threadId'],
                'native_turn': params['turnId'], 'call_id': params['callId']},
            'call': {'name': params['tool'], 'arguments': params['arguments']}}}
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(env['BOT_CODE_AGENT_SOCKET'])
            client.sendall(json.dumps(request).encode() + b'\n')
            response = json.loads(client.makefile().readline())
        log('tool-results.jsonl', {'thread': run['thread'], 'turn': run['turn'], 'index': index, 'response': response})
    if run['finish']:
        finish(run)


for line in sys.stdin:
    request = json.loads(line)
    log('calls.jsonl', request)
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        emit({'id': request['id'], 'result': {'userAgent': 'Agent tools fixture'}})
    elif method == 'collaborationMode/list':
        emit({'id': request['id'], 'result': {'data': []}})
    elif method == 'model/list':
        emit({'id': request['id'], 'result': {'data': [], 'nextCursor': None}})
    elif method == 'account/rateLimits/read':
        emit({'id': request['id'], 'result': {'rateLimits': {'primary': None, 'secondary': None}}})
    elif method in ('thread/start', 'thread/resume', 'thread/fork'):
        counter += 1
        thread = params['threadId'] if method == 'thread/resume' else f'native-{os.getpid()}-{counter}'
        if 'config' in params:
            configs[thread] = params['config']['mcp_servers.botcode']
        turns = json.loads((root / 'history.json').read_text()) if (root / 'history.json').exists() else []
        emit({'id': request['id'], 'result': {'thread': {'id': thread, 'turns': turns}}})
    elif method == 'turn/start':
        prompt = params['input'][0]['text']
        plan = json.loads((root / 'plans.json').read_text()).get(prompt, {'steps': []})
        run = {'thread': params['threadId'], 'turn': 'turn-' + params['clientUserMessageId'],
               'steps': plan['steps'], 'index': 0, 'finish': plan.get('finish', True), 'stale': plan.get('staleCompletion', False)}
        active[run['thread']] = run
        emit({'id': request['id'], 'result': {'turn': {'id': run['turn'], 'status': 'inProgress', 'items': []}}})
        emit({'method': 'turn/started', 'params': {'threadId': run['thread'], 'turn': {'id': run['turn']}}})
        if plan.get('transport') == 'mcp':
            threading.Thread(target=mcp_run, args=(run,), daemon=True).start()
        else:
            next_dynamic(run)
    elif method == 'turn/interrupt':
        emit({'id': request['id'], 'result': {}})
        finish(active[params['threadId']], 'interrupted')
    elif method is None and request.get('id') in pending:
        run = pending.pop(request['id'])
        log('tool-results.jsonl', {'thread': run['thread'], 'turn': run['turn'], 'index': run['index'], 'response': request})
        run['index'] += 1
        next_dynamic(run)
