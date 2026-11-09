import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const evaluator = fileURLToPath(new URL('../../../scripts/acceptance-eval.py', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/acceptance-sums.json', import.meta.url))

void test('offline authoring distinguishes false accepts, false rejects and actual consumer failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-authoring-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const good = `python3 - <<'PY'
import json,subprocess,sys
from pathlib import Path
rows=json.loads(Path('records.json').read_text()); expected={}
for row in rows: expected[row['key']]=expected.get(row['key'],0)+row['value']
assert json.loads(Path('result/totals.json').read_text()) == expected
assert json.loads(subprocess.check_output([sys.executable,'result/consumer.py','records.json'])) == expected
Path('empty.json').write_text('[]')
assert json.loads(subprocess.check_output([sys.executable,'result/consumer.py','empty.json'])) == {}
PY`
  for (const [name, check, falseAccepts, falseRejects] of [['independent', good, 0, 0], ['vacuous', 'true', 6, 0], ['bad-path', 'test -f worker-checkout/result.json', 0, 1]] as const) {
    const path = join(root, `${name}.sh`)
    await writeFile(path, check)
    const { stdout } = await execute('python3', [evaluator, fixture, 'evaluate', '--check', path])
    const report = JSON.parse(stdout) as { falseAccepts: number; falseRejects: number; modelEvidence: unknown }
    assert.equal(report.falseAccepts, falseAccepts)
    assert.equal(report.falseRejects, falseRejects)
    assert.equal(report.modelEvidence, null)
  }
  for (const variant of ['historical', 'compact', 'examples']) {
    const { stdout } = await execute('python3', [evaluator, fixture, 'prompt', '--interface', variant])
    const prompt = JSON.parse(stdout) as Record<string, unknown>
    assert.equal(Object.hasOwn(prompt, 'artifacts'), false, 'model never sees held-out correct/incorrect outputs')
    assert.equal(Object.hasOwn(prompt, 'template'), variant === 'historical')
  }
})

void test('offline authoring evaluates a different byte consumer with held-out empty and high-bit inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-bytes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'check.sh')
  await writeFile(path, `python3 - <<'PY'
import base64,json,subprocess,sys
from pathlib import Path
def expected(request):
    b=base64.b64decode(request['data'],validate=True)
    return {'length':len(b),'data':base64.b64encode(bytes(x^165 for x in b)).decode()}
text=Path('input.json').read_text()
assert json.loads(Path('result/response.json').read_text()) == expected(json.loads(text))
for name,request in [('input.json',json.loads(text)),('empty.json',{'data':''}),('other.json',{'data':'//8AAIE='})]:
    if name != 'input.json': Path(name).write_text(json.dumps(request))
    actual=json.loads(subprocess.check_output([sys.executable,'result/consumer.py',name]))
    assert actual == expected(request), (name,actual)
assert Path('input.json').read_text() == text
PY`)
  const bytesFixture = fileURLToPath(new URL('./fixtures/acceptance-bytes.json', import.meta.url))
  const { stdout } = await execute('python3', [evaluator, bytesFixture, 'evaluate', '--check', path])
  const report = JSON.parse(stdout) as { falseAccepts: number; falseRejects: number; correctAcceptanceRate: number; incorrectRejectionRate: number }
  assert.equal(report.falseAccepts, 0)
  assert.equal(report.falseRejects, 0)
  assert.equal(report.correctAcceptanceRate, 1)
  assert.equal(report.incorrectRejectionRate, 1)
})
