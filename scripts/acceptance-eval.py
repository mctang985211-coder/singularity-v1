#!/usr/bin/env python3
"""Offline acceptance-authoring measurement. Never called by Task admission.

prompt emits only the goal and public inputs; evaluate runs a saved shell check
against separately held correct and incorrect artifacts in fresh directories.
Model calls, their budget and corrections are owned by the experiment operator.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def prompt(fixture, interface):
    view = {'goal': fixture['goal'], 'inputs': fixture['inputs'], 'outputs': fixture['outputs']}
    if interface == 'historical':
        view['template'] = {'id': 'consumer', 'requiredCriteria': [], 'requiredOutputs': fixture['outputs'],
                            'skills': [], 'tools': [], 'children': [], 'instanceSchema': 'TaskProposal',
                            'acceptancePolicy': 'host-resolved', 'example': 'reference only'}
    view['instruction'] = 'Write a self-contained bash acceptance check for this goal, inputs and result/. Return only the shell script.'
    if interface == 'examples':
        view['example'] = ('Independently derive expected values from frozen inputs and invoke the actual consumer. '
                           'Check concrete differences and useful edge cases. A known-wrong output should fail. '
                           'Use only declared paths; self-reported PASS is insufficient.')
    return view


def materialize(root, files):
    for name, text in files.items():
        path = root / name
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('fixture paths must stay in the fresh directory')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def evaluate(fixture, check, timeout):
    started = time.monotonic()
    rows = []
    for artifact in fixture['artifacts']:
        with tempfile.TemporaryDirectory(prefix='acceptance-eval-') as directory:
            root = Path(directory)
            materialize(root, fixture['inputs'])
            materialize(root, artifact['files'])
            # Own the shell and its process group until every timeout is reaped.
            process = subprocess.Popen(['bash', '-e', '-o', 'pipefail', '-c', check], cwd=root,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       start_new_session=True)
            timed_out = False
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
            accepted = process.returncode == 0 and not timed_out
            rows.append({'id': artifact['id'], 'correct': artifact['correct'], 'accepted': accepted,
                         'timedOut': timed_out, 'exit': process.returncode, 'stdout': stdout, 'stderr': stderr})
    correct = [row for row in rows if row['correct']]
    incorrect = [row for row in rows if not row['correct']]
    return {'fixture': fixture['id'], 'rows': rows,
            'correctAcceptanceRate': sum(row['accepted'] for row in correct) / len(correct),
            'incorrectRejectionRate': sum(not row['accepted'] for row in incorrect) / len(incorrect),
            'falseAccepts': sum(row['accepted'] for row in incorrect),
            'falseRejects': sum(not row['accepted'] for row in correct),
            'timeouts': sum(row['timedOut'] for row in rows),
            'elapsedMs': (time.monotonic() - started) * 1000,
            'modelEvidence': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture', type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    author = commands.add_parser('prompt')
    author.add_argument('--interface', choices=['historical', 'compact', 'examples'], required=True)
    measure = commands.add_parser('evaluate')
    measure.add_argument('--check', required=True, type=Path)
    measure.add_argument('--timeout', type=float, default=10)
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text())
    result = prompt(fixture, args.interface) if args.command == 'prompt' else evaluate(fixture, args.check.read_text(), args.timeout)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
