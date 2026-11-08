#!/usr/bin/env python3
import base64
import json
from pathlib import Path
import shlex
import subprocess
import sys
import struct

from bemu import environment, records, replay

GUARD = 0x5A5A5A5A
REGRESSIONS = ('smatmul_16x16x32_test', 'smatmul_bias_accumulate_test')


def remove_if_present(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def build_request(project):
    case = project['case']
    m, n, k, seed = case['m'], case['n'], case['k'], case['seed']
    a = bytes(((11 * i + seed) % 17) - 8 & 255 for i in range(m * k))
    b = bytes(((7 * i + 2 * seed) % 19) - 9 & 255 for i in range(k * n))
    bias = [((3 * j + seed) % 13) - 6 for j in range(n)]
    return {
        'v': 1, 'm': m, 'n': n, 'k': k,
        'a': base64.b64encode(a).decode('ascii'),
        'b': base64.b64encode(b).decode('ascii'),
        'bias': bias, 'guard': [GUARD] * 8,
    }


def signed(data):
    return [value - 256 if value >= 128 else value for value in base64.b64decode(data, validate=True)]


def expected(request):
    a, b, bias = signed(request['a']), signed(request['b']), request['bias']
    m, n, k = request['m'], request['n'], request['k']
    assert len(a) == m * k and len(b) == k * n and len(bias) == n
    return [bias[column] + sum(a[row * k + inner] * b[inner * n + column] for inner in range(k))
            for row in range(m) for column in range(n)]


def option_value(tokens, name):
    for index, token in enumerate(tokens):
        if token == name:
            assert index + 1 < len(tokens), name
            return tokens[index + 1]
        if token.startswith(name + '='):
            return token.split('=', 1)[1]
    return None


def check_command(command, name, regression=False):
    assert isinstance(command, dict) and set(command) == {'name', 'argv', 'cwd', 'exit', 'stdout', 'stderr'}
    assert command['name'] == name and command['exit'] == 0
    assert isinstance(command['cwd'], str) and command['cwd']
    assert isinstance(command['stdout'], str) and isinstance(command['stderr'], str)
    argv = command['argv']
    assert isinstance(argv, list) and all(isinstance(part, str) for part in argv)
    tokens = [token for part in argv for token in shlex.split(part)]
    direct = option_value(tokens, '--elf') is not None
    assert ('bemu' in Path(argv[0]).name and direct) or ('bebop-bemu' in tokens and '--sim' in tokens)
    if not direct:
        assert option_value(tokens, '--chip') == 'pebble'
    assert option_value(tokens, '--core-index') == '0'
    assert any('smatmul' in token for token in tokens)
    if regression:
        assert any(name in token for token in tokens)


def verify_response(request, response):
    assert isinstance(response, dict) and set(response) == {'v', 'c', 'guard', 'command', 'regressions'}
    assert response['v'] == 1 and response['guard'] == request['guard'] == [GUARD] * 8
    assert response['c'] == expected(request)
    check_command(response['command'], 'smatmul-bias')
    regressions = response['regressions']
    assert isinstance(regressions, list) and len(regressions) == len(REGRESSIONS)
    assert {entry.get('name') for entry in regressions if isinstance(entry, dict)} == set(REGRESSIONS)
    for name in REGRESSIONS:
        check_command(next(entry for entry in regressions if entry['name'] == name), name, regression=True)


def main():
    root = Path.cwd()
    project = json.loads((root / 'project.json').read_text())
    environment(project, 'pebble')
    request = build_request(project)
    request_path = root / 'request.json'
    response_path = root / 'response.json'
    request_path.write_text(json.dumps(request, separators=(',', ':')))
    request_text = request_path.read_text()
    try:
        completed = subprocess.run(
            [sys.executable, 'ball/smatmul.py', str(request_path), str(response_path)],
            cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=60 * 60,
        )
        assert request_path.read_text() == request_text, 'consumer modified frozen request bytes'
    finally:
        remove_if_present(request_path)
    if completed.returncode != 0:
        print(completed.stdout)
        print(completed.stderr, file=sys.stderr)
        raise SystemExit(completed.returncode)
    response = json.loads(response_path.read_text())
    verify_response(request, response)
    raw = {'smatmul_a': base64.b64decode(request['a'], validate=True),
           'smatmul_b': base64.b64decode(request['b'], validate=True),
           'smatmul_bias': b''.join(struct.pack('<i', value) for value in request['bias'])}
    stdout = replay(project, response['command'], 'pebble', 0, raw)
    assert records(stdout, 'SMATMULSHAPE') == [[str(request[key]) for key in ('m', 'n', 'k')]]
    values = [int(word) for row in records(stdout, 'SMATMULC') for word in row]
    guards = records(stdout, 'SMATMULGUARD')
    assert values == response['c'] and len(guards) == 1 and [int(word, 16) for word in guards[0]] == request['guard'], 'independent SMatMul device result mismatch'
    for command in response['regressions']:
        replay(project, command, 'pebble', 0, regression=True)
    print('verified frozen int8 SMatMul with bias and both focused-BEMU regressions')


if __name__ == '__main__':
    main()
