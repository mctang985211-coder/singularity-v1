import assert from 'node:assert/strict'
import test from 'node:test'

import * as protocol from '../src/index.ts'
import { planningSketchDraftSchema, planningSketchSchema } from '../src/planning.ts'
import type { PlanningSketch } from '../src/planning.ts'
import { parseProtocolValue } from '../src/schema.ts'

const digestA = `sha256:${'a'.repeat(64)}`

const levelZero = {
  level: 0 as const,
  purpose: 'Coordinate this Run and decide whether the work needs direct children',
  likelyChildren: [],
  expectedInputs: ['current frozen TaskSpec'],
  expectedOutputs: ['integrated result'],
}

const levelOne = {
  level: 1 as const,
  purpose: 'Build the bounded implementation part',
  likelyChildren: ['build-part', 'probe-part'],
  expectedInputs: ['frozen input object'],
  expectedOutputs: ['implementation artifact'],
}

const levelTwo = {
  level: 2 as const,
  purpose: 'Probe the implementation part from its own child scope',
  likelyChildren: ['probe-part'],
  expectedInputs: ['implementation artifact'],
  expectedOutputs: ['probe notes'],
}

const directPlan: PlanningSketch['directPlan'] = [
  { bindingId: 'build-part', purpose: 'Produce the bounded implementation' },
  { bindingId: 'probe-part', purpose: 'Probe the implementation under its own evidence' },
]

const twoLevelSketch: PlanningSketch = {
  v: 1,
  taskId: 'task-root',
  runId: 'run-root-1',
  contextEpoch: 'epoch-1',
  objective: 'Deliver the bounded root result',
  levels: [levelZero, levelOne],
  directPlan: [directPlan[0]],
  assumptions: ['the frozen inputs are sufficient'],
  sourceContract: digestA,
}

const threeLevelSketch: PlanningSketch = {
  ...twoLevelSketch,
  levels: [levelZero, levelOne, levelTwo],
  directPlan,
  assumptions: ['the frozen inputs are sufficient', 'grandchildren remain local to each child'],
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sketchRecord(sketch: PlanningSketch): Record<string, unknown> {
  return sketch as unknown as Record<string, unknown>
}

function firstLevel(sketch: PlanningSketch): Record<string, unknown> {
  const level = sketch.levels.at(0)
  if (level === undefined) throw new Error('expected a planning level')
  return level as unknown as Record<string, unknown>
}

function firstDirectPlan(sketch: PlanningSketch): Record<string, unknown> {
  const entry = sketch.directPlan.at(0)
  if (entry === undefined) throw new Error('expected a direct plan entry')
  return entry as unknown as Record<string, unknown>
}

void test('protocol index exports the PlanningSketch schema', () => {
  assert.equal(protocol.planningSketchSchema, planningSketchSchema)
})

void test('PlanningSketchDraft excludes every host identity', () => {
  const draft = {
    v: threeLevelSketch.v, objective: threeLevelSketch.objective,
    levels: threeLevelSketch.levels, directPlan: threeLevelSketch.directPlan, assumptions: threeLevelSketch.assumptions,
  }
  assert.deepEqual(parseProtocolValue(planningSketchDraftSchema, draft), draft)
  for (const identity of ['taskId', 'runId', 'contextEpoch', 'sourceContract'] as const) {
    assert.throws(() => parseProtocolValue(planningSketchDraftSchema, { ...draft, [identity]: threeLevelSketch[identity] }), identity)
  }
})

void test('PlanningSketch accepts structural two-level and three-level plans', () => {
  const twoLevel = parseProtocolValue(planningSketchSchema, clone(twoLevelSketch))
  assert.deepEqual(twoLevel, twoLevelSketch)
  assert.equal(twoLevel.levels.length, 2)

  const threeLevel = parseProtocolValue(planningSketchSchema, clone(threeLevelSketch))
  assert.deepEqual(threeLevel, threeLevelSketch)
  assert.equal(threeLevel.levels.length, 3)
  assert.deepEqual(
    threeLevel.levels.map(level => level.level),
    [0, 1, 2],
  )
  assert.deepEqual(
    threeLevel.directPlan.map(entry => entry.bindingId),
    ['build-part', 'probe-part'],
  )
})

void test('PlanningSketch accepts only ordered [0,1] or [0,1,2] levels', () => {
  const invalidSequences: readonly {
    readonly label: string
    readonly levels: readonly unknown[]
  }[] = [
    { label: 'empty levels', levels: [] },
    { label: 'only level 0', levels: [levelZero] },
    { label: 'duplicate level 0', levels: [levelZero, levelZero] },
    { label: 'out of order levels', levels: [levelOne, levelZero] },
    { label: 'skips level 1', levels: [levelZero, levelTwo] },
    { label: 'duplicate level 2', levels: [levelZero, levelOne, levelTwo, levelTwo] },
    { label: 'more than three levels', levels: [levelZero, levelOne, levelTwo, levelZero] },
  ]

  for (const { label, levels } of invalidSequences) {
    const sketch = { ...clone(threeLevelSketch), levels }
    assert.throws(
      () => parseProtocolValue(planningSketchSchema, sketch),
      label,
    )
  }
})

void test('PlanningSketch preserves absent optional-looking fields and does not mutate input', () => {
  const sketch: PlanningSketch = {
    ...threeLevelSketch,
    levels: [
      {
        level: 0,
        purpose: 'Keep only frozen fields',
        likelyChildren: [],
        expectedInputs: [],
        expectedOutputs: [],
      },
      {
        level: 1,
        purpose: 'Keep one direct child intent without extra fields',
        likelyChildren: [],
        expectedInputs: [],
        expectedOutputs: [],
      },
    ],
    directPlan: [],
    assumptions: [],
  }
  const before = clone(sketch)
  const parsed = parseProtocolValue(planningSketchSchema, sketch)

  assert.deepEqual(parsed, sketch)
  assert.deepEqual(sketch, before)
  assert.equal('join' in (parsed.directPlan.at(0) ?? {}), false)
  assert.equal('acceptance' in parsed, false)
  assert.equal('resources' in parsed, false)
  assert.equal('verifier' in parsed, false)
})

void test('PlanningSketch rejects level values outside the frozen 0/1/2 union', () => {
  const invalidLevels: readonly unknown[] = [3, -1, 1.5, '1', null, false]

  for (const level of invalidLevels) {
    const sketch = clone(threeLevelSketch)
    firstLevel(sketch)['level'] = level
    assert.throws(
      () => parseProtocolValue(planningSketchSchema, sketch),
      `level ${String(level)}`,
    )
  }
})

void test('PlanningSketch rejects unknown fields at every object level', () => {
  const topLevel = sketchRecord(clone(threeLevelSketch))
  topLevel['unexpected'] = true
  assert.throws(() => parseProtocolValue(planningSketchSchema, topLevel))

  const level = clone(threeLevelSketch)
  firstLevel(level)['unexpected'] = true
  assert.throws(() => parseProtocolValue(planningSketchSchema, level))

  const directPlanEntry = clone(threeLevelSketch)
  firstDirectPlan(directPlanEntry)['unexpected'] = true
  assert.throws(() => parseProtocolValue(planningSketchSchema, directPlanEntry))
})

void test('PlanningSketch rejects model-supplied authority fields at the sketch level', () => {
  const authorityFields: readonly (readonly [string, unknown])[] = [
    ['acceptance', { id: 'acceptance-model', digest: digestA }],
    ['resources', { baseTools: [], skills: [], mcpServers: [] }],
    ['verifier', 'model-verifier'],
    ['environment', { seed: 'seed-model', profile: 'profile-model' }],
    ['limits', { maxRuns: 99 }],
    ['required', true],
    ['role', 'deliverable'],
    ['join', 'required'],
    ['criteria', [{ id: 'criterion-model', statement: 'model acceptance', required: true }]],
    ['digest', digestA],
  ]

  for (const [field, value] of authorityFields) {
    const sketch = clone(threeLevelSketch) as unknown as Record<string, unknown>
    sketch[field] = value
    assert.throws(
      () => parseProtocolValue(planningSketchSchema, sketch),
      field,
    )
  }
})

void test('PlanningSketch rejects authority fields inside planning levels', () => {
  const authorityFields: readonly (readonly [string, unknown])[] = [
    ['acceptance', { id: 'acceptance-model', digest: digestA }],
    ['resources', { baseTools: [], skills: [], mcpServers: [] }],
    ['verifier', 'model-verifier'],
    ['join', 'required'],
    ['required', true],
    ['role', 'deliverable'],
    ['criteria', [{ id: 'criterion-model', statement: 'model acceptance', required: true }]],
    ['taskId', 'task-model'],
    ['digest', digestA],
  ]

  for (const [field, value] of authorityFields) {
    const sketch = clone(threeLevelSketch)
    firstLevel(sketch)[field] = value
    assert.throws(
      () => parseProtocolValue(planningSketchSchema, sketch),
      field,
    )
  }
})

void test('PlanningSketch rejects directPlan.join and other direct-plan authority fields', () => {
  const authorityFields: readonly (readonly [string, unknown])[] = [
    ['join', 'required'],
    ['acceptance', { id: 'acceptance-model', digest: digestA }],
    ['resources', { baseTools: [], skills: [], mcpServers: [] }],
    ['verifier', 'model-verifier'],
    ['required', true],
    ['role', 'deliverable'],
    ['taskId', 'task-model'],
    ['acceptanceCriteria', [{ id: 'criterion-model', statement: 'model acceptance' }]],
    ['digest', digestA],
  ]

  for (const [field, value] of authorityFields) {
    const sketch = clone(threeLevelSketch)
    firstDirectPlan(sketch)[field] = value
    assert.throws(
      () => parseProtocolValue(planningSketchSchema, sketch),
      field,
    )
  }
})

void test('PlanningSketch keeps directPlan as flat level-1 entries without a level field', () => {
  const parsed = parseProtocolValue(planningSketchSchema, clone(threeLevelSketch))
  const levelOneEntry = parsed.levels.at(1)
  assert.ok(levelOneEntry !== undefined)
  assert.equal(levelOneEntry.level, 1)

  for (const entry of parsed.directPlan) {
    assert.deepEqual(Object.keys(entry).sort(), ['bindingId', 'purpose'])
    assert.ok(levelOneEntry.likelyChildren.includes(entry.bindingId))
  }

  const sketch = clone(threeLevelSketch)
  firstDirectPlan(sketch)['level'] = 1
  assert.throws(() => parseProtocolValue(planningSketchSchema, sketch))
})

void test('PlanningSketch rejects missing required fields and wrong frozen types', () => {
  const missing = clone(threeLevelSketch) as unknown as Record<string, unknown>
  delete missing['objective']
  assert.throws(() => parseProtocolValue(planningSketchSchema, missing))

  const missingLevelField = clone(threeLevelSketch)
  delete firstLevel(missingLevelField)['purpose']
  assert.throws(() => parseProtocolValue(planningSketchSchema, missingLevelField))

  const missingDirectPlanField = clone(threeLevelSketch)
  delete firstDirectPlan(missingDirectPlanField)['bindingId']
  assert.throws(() => parseProtocolValue(planningSketchSchema, missingDirectPlanField))

  const wrongVersion = clone(threeLevelSketch) as unknown as Record<string, unknown>
  wrongVersion['v'] = 2
  assert.throws(() => parseProtocolValue(planningSketchSchema, wrongVersion))

  const wrongLevels = clone(threeLevelSketch) as unknown as Record<string, unknown>
  wrongLevels['levels'] = { level: 0 }
  assert.throws(() => parseProtocolValue(planningSketchSchema, wrongLevels))

  const wrongChildren = clone(threeLevelSketch)
  firstLevel(wrongChildren)['likelyChildren'] = 'build-part'
  assert.throws(() => parseProtocolValue(planningSketchSchema, wrongChildren))

  const wrongSourceContract = clone(threeLevelSketch) as unknown as Record<string, unknown>
  wrongSourceContract['sourceContract'] = 'sha256:short'
  assert.throws(() => parseProtocolValue(planningSketchSchema, wrongSourceContract))
})
