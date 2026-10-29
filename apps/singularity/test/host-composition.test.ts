import assert from 'node:assert/strict'
import test from 'node:test'

import { bootSpikeProfile } from '../src/host-composition.ts'

test('alpha2 profile boots a real agent with scoped capabilities before its first request', async () => {
  const spike = await bootSpikeProfile()
  try {
    assert.equal(spike.dshVersion, '0.2.2-alpha.2')
    assert.equal(spike.agent.setupCompletedBeforeCreate, true)
  } finally {
    await spike.dispose()
  }
})
