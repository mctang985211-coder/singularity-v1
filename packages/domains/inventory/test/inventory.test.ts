import assert from 'node:assert/strict'
import test from 'node:test'

import { INVENTORY_CASES, reconcileInventory } from '../src/index.ts'

void test('inventory reconciliation retains zero and negative totals, accounts for every row, and sorts SKUs', () => {
  assert.deepEqual(reconcileInventory(INVENTORY_CASES[1].csv), {
    rowCount: 5, totals: [{ sku: 'AXLE', quantity: 8 }, { sku: 'GEAR', quantity: 0 }, { sku: 'PIN', quantity: -2 }],
  })
  assert.deepEqual(reconcileInventory('sku,delta\n'), { rowCount: 0, totals: [] })
  assert.throws(() => reconcileInventory('sku,delta\nPART,9007199254740992\n'), /precision/)
})
