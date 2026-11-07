#!/usr/bin/env python3
import base64
import json
import math
from pathlib import Path
import shlex
import struct
import subprocess
import sys

BLOCK = 32
GUARD = 0x5A5A5A5A
REGRESSIONS = (
    'mxmm_bank_capacity_test',
    'mxmm_window_test',
    'mxmm_window_chain_test',
    'mxmm_window_rows_test',
)


def case_code(i, seed):
    value = (73 * i + 19 * (i // 256) + seed) % 127
    if i % 2:
        value |= 128
    if i % 257 == 0:
        value = 0
    if i % 263 == 0:
        value = 128
    return value


def operand_bytes(rows, k, seed):
    codes = bytes(case_code(i, seed) for i in range(rows * k))
    scales = bytes(112 + ((11 * i + seed) % 32) for i in range(rows * (k // BLOCK)))
    return codes, scales


def build_request(project):
    calls = []
    for vector, (m, n, k) in enumerate(project['case']['shapes']):
        seed = project['case']['seed'] + vector
        a_codes, a_scales = operand_bytes(m, k, seed)
        b_codes, b_scales = operand_bytes(n, k, seed)
        call = {
            'id': f'vector-{vector}', 'm': m, 'n': n, 'k': k,
            'aCodes': base64.b64encode(a_codes).decode('ascii'),
            'aScales': base64.b64encode(a_scales).decode('ascii'),
            'bCodes': base64.b64encode(b_codes).decode('ascii'),
            'bScales': base64.b64encode(b_scales).decode('ascii'),
            'guard': [GUARD] * 8,
        }
        calls.append(call)
        if vector == len(project['case']['shapes']) - 1:
            calls.append({**call, 'id': f'vector-{vector}-repeat'})
    return {'v': 1, 'calls': calls}


def unit(code):
    exponent = (code >> 3) & 15
    mantissa = code & 7
    return mantissa if exponent == 0 else (8 + mantissa) << (exponent - 1)


def decode_bytes(call):
    m, n, k = call['m'], call['n'], call['k']
    a_codes = base64.b64decode(call['aCodes'], validate=True)
    a_scales = base64.b64decode(call['aScales'], validate=True)
    b_codes = base64.b64decode(call['bCodes'], validate=True)
    b_scales = base64.b64decode(call['bScales'], validate=True)
    assert len(a_codes) == m * k and len(b_codes) == n * k
    assert len(a_scales) == m * (k // BLOCK) and len(b_scales) == n * (k // BLOCK)
    return a_codes, a_scales, b_codes, b_scales


def exact_cell(call, decoded, row, column):
    a_codes, a_scales, b_codes, b_scales = decoded
    k = call['k']
    blocks = k // BLOCK
    terms = []
    absolute = []
    for block in range(blocks):
        exponent = ((a_scales[row * blocks + block] or 0) - 127
                    + (b_scales[column * blocks + block] or 0) - 127 - 18)
        total = 0
        magnitude = 0
        for offset in range(BLOCK):
            a = a_codes[row * k + block * BLOCK + offset]
            b = b_codes[column * k + block * BLOCK + offset]
            product = unit(a) * unit(b)
            if (a ^ b) & 128:
                product = -product
            total += product
            magnitude += abs(product)
        terms.append((total, exponent))
        absolute.append((magnitude, exponent))
    minimum = min(exponent for _, exponent in terms)
    exact = sum(value << (exponent - minimum) for value, exponent in terms)
    magnitude = sum(value << (exponent - minimum) for value, exponent in absolute)
    return exact, magnitude, minimum


def rne32(number, exponent):
    if number == 0:
        return 0
    sign = 0x80000000 if number < 0 else 0
    number = abs(number)
    leading = number.bit_length() - 1 + exponent
    if leading > 127:
        raise AssertionError('frozen input exceeds finite FP32')
    quantum = leading - 23 if leading >= -126 else -149
    shift = exponent - quantum
    if shift >= 0:
        scaled = number << shift
    else:
        distance = -shift
        scaled, remainder = divmod(number, 1 << distance)
        halfway = 1 << (distance - 1)
        if remainder > halfway or (remainder == halfway and scaled & 1):
            scaled += 1
    if leading >= -126:
        if scaled == 1 << 24:
            scaled >>= 1
            leading += 1
        if leading > 127:
            raise AssertionError('frozen input exceeds finite FP32')
        return sign | ((leading + 127) << 23) | (scaled - (1 << 23))
    if scaled >= 1 << 23:
        return sign | (1 << 23)
    return sign | scaled


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
    # Accept the native argv form and the documented single option-string form.
    tokens = [token for part in argv for token in shlex.split(part)]
    assert 'bebop-bemu' in tokens and '--sim' in tokens
    assert option_value(tokens, '--chip') == 'poly'
    assert option_value(tokens, '--core-index') == '2'
    if regression:
        assert any(name in token for token in tokens)


def verify_response(project, request, response):
    assert isinstance(response, dict) and set(response) == {'v', 'calls', 'regressions'}
    assert response['v'] == 1
    assert len(response['calls']) == len(request['calls'])
    previous = None
    for index, (call, result) in enumerate(zip(request['calls'], response['calls'])):
        assert isinstance(result, dict) and set(result) == {'id', 'c', 'guard', 'command'}
        assert result['id'] == call['id']
        assert result['guard'] == call['guard'] == [GUARD] * 8
        assert isinstance(result['c'], list) and len(result['c']) == call['m'] * call['n']
        check_command(result['command'], call['id'])
        decoded = decode_bytes(call)
        for row in range(call['m']):
            for column in range(call['n']):
                actual = result['c'][row * call['n'] + column]
                assert isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isfinite(actual)
                exact, magnitude, exponent = exact_cell(call, decoded, row, column)
                expected_bits = rne32(exact, exponent)
                if struct.pack('<f', actual) == struct.pack('<I', expected_bits):
                    continue
                exact_value = math.ldexp(exact, exponent)
                absolute_sum = math.ldexp(magnitude, exponent)
                unit_roundoff = 2.0 ** -24
                gamma = call['k'] * unit_roundoff / (1 - call['k'] * unit_roundoff)
                tolerance = (gamma * absolute_sum + unit_roundoff * abs(exact_value)) * (1 + 2.0 ** -20)
                assert abs(actual - exact_value) <= tolerance, (call['id'], row, column, actual, exact_value, tolerance)
        if index > 0 and request['calls'][index - 1]['id'] + '-repeat' == call['id']:
            assert previous is not None and result['c'] == previous
        previous = result['c']
    regressions = response['regressions']
    assert isinstance(regressions, list) and len(regressions) == len(REGRESSIONS)
    assert {entry.get('name') for entry in regressions if isinstance(entry, dict)} == set(REGRESSIONS)
    for name in REGRESSIONS:
        command = next(entry for entry in regressions if entry['name'] == name)
        check_command(command, name, regression=True)


def main():
    root = Path.cwd()
    project = json.loads((root / 'project.json').read_text())
    request = build_request(project)
    request_path = root / 'request.json'
    response_path = root / 'response.json'
    request_path.write_text(json.dumps(request, separators=(',', ':')))
    try:
        completed = subprocess.run(
            [sys.executable, 'ball/mxmm.py', str(request_path), str(response_path)],
            cwd=root, capture_output=True, text=True, timeout=6 * 60 * 60,
        )
    finally:
        request_path.unlink(missing_ok=True)
    if completed.returncode != 0:
        print(completed.stdout)
        print(completed.stderr, file=sys.stderr)
        raise SystemExit(completed.returncode)
    response = json.loads(response_path.read_text())
    verify_response(project, request, response)
    print(f"verified {len(request['calls'])} frozen MXFP8 calls and {len(REGRESSIONS)} focused-BEMU regressions")


if __name__ == '__main__':
    main()
