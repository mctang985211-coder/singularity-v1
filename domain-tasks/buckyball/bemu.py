"""Domain-only inspection and independent replay of submitted RISC-V ELFs.

project.bemu maps chip names to operator-prepared, trusted focused BEMU binaries.
The consumer's argv/stdout are descriptions, never execution authority.
"""
from pathlib import Path
import re
import struct
import subprocess
import tempfile


def environment(project, chip):
    binary = Path(project['bemu'][chip])
    assert binary.is_absolute() and binary.is_file(), 'prepare project.bemu before execution'
    return binary


def executable(command, chip):
    root = Path.cwd().resolve()
    cwd = Path(command['cwd']).resolve()
    assert cwd.is_relative_to(root), 'ELF checkout must be inside the fresh acceptance directory'
    # The documented bbdev option-string and native argv forms are both accepted.
    import shlex
    tokens = [word for arg in command['argv'] for word in shlex.split(arg)]
    name = None
    direct = None
    for index, token in enumerate(tokens):
        if token == '--elf':
            direct = tokens[index + 1]
        elif token == '--binary':
            name = tokens[index + 1]
        elif token.startswith('--binary='):
            name = token.split('=', 1)[1]
    if direct is not None:
        elf = Path(direct).resolve()
    else:
        assert name and Path(name).name == name, 'declare one built ELF by binary name'
        matches = list((cwd / 'bb-tests/output' / chip / 'workloads').rglob(name))
        assert len(matches) == 1 and matches[0].is_file(), f'ELF must resolve uniquely: {name}'
        elf = matches[0].resolve()
    assert elf.is_relative_to(root), 'ELF must be a frozen consumer build'
    header = elf.read_bytes()[:64]
    assert header[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', header, 18)[0] == 243, 'expected RV64 little-endian ELF'
    return elf


def check_inputs(elf, inputs):
    """Read actual loadable ELF bytes at named symbols, independently of the CLI."""
    symbols = subprocess.run(['readelf', '-sW', str(elf)], check=True, capture_output=True, text=True).stdout
    data = elf.read_bytes()
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    segments = [struct.unpack_from('<IIQQQQQQ', data, offset + index * size) for index in range(count)]
    for name, expected in inputs.items():
        entries = [line.split() for line in symbols.splitlines() if line.split() and line.split()[-1] == name]
        assert len(entries) == 1, f'preserve raw input symbol {name}'
        address = int(entries[0][1], 16)
        symbol_size = int(entries[0][2], 0)
        assert symbol_size in (len(expected), len(expected) + 1), f'{name}: unexpected size'
        loads = [segment for segment in segments if segment[0] == 1 and segment[3] <= address
                 and address + symbol_size <= segment[3] + segment[5]]
        assert len(loads) == 1, f'{name}: bytes must be in a loadable segment'
        segment = loads[0]
        start = segment[2] + address - segment[3]
        assert data[start:start + len(expected)] == expected, f'{name}: altered original input bytes'


def replay(project, command, chip, core, inputs=None, regression=False):
    elf = executable(command, chip)
    if inputs is not None:
        check_inputs(elf, inputs)
    with tempfile.TemporaryDirectory(prefix='bemu-check-') as logs:
        completed = subprocess.run([str(environment(project, chip)), '--elf', str(elf),
                                    '--core-index', str(core), '--log-dir', logs],
                                   cwd=elf.parent, capture_output=True, text=True, timeout=3600)
    assert completed.returncode == 0, f'independent BEMU failed: {completed.stdout}\n{completed.stderr}'
    if regression:
        assert re.search(r'\bPASS\b', completed.stdout), 'regression produced no device PASS'
    return completed.stdout


def records(stdout, tag):
    text = re.sub(r'\x1b\[[0-9;]*m', '', stdout)
    return [line[line.index(tag):].split()[1:] for line in text.splitlines()
            if re.search(r'\b' + re.escape(tag) + r'\b', line)]


def mxmm_output(stdout, call):
    shapes = records(stdout, 'MXMMSHAPE')
    assert len(shapes) == 1 and list(map(int, shapes[0][:3])) == [call['m'], call['n'], call['k']]
    repetitions = []
    for rep in range(2):
        cells = {}
        for row in records(stdout, 'MXMMCROW'):
            repetition, m, n0 = map(int, row[:3])
            if repetition != rep:
                continue
            for n, word in enumerate(row[3:], n0):
                assert 0 <= m < call['m'] and 0 <= n < call['n'] and (m, n) not in cells
                cells[m, n] = int(word, 16)
        assert len(cells) == call['m'] * call['n'], 'device C coverage is incomplete'
        guards = [list(int(word, 16) for word in row[1:]) for row in records(stdout, 'MXMMGUARD') if int(row[0]) == rep]
        assert guards and all(guard == call['guard'] for guard in guards), 'device guard mismatch'
        repetitions.append([cells[m, n] for m in range(call['m']) for n in range(call['n'])])
    assert repetitions[0] == repetitions[1] and records(stdout, 'MXMMDONE'), 'device repeat failed'
    return [struct.unpack('<f', struct.pack('<I', word))[0] for word in repetitions[-1]]
