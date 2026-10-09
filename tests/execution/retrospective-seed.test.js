// Synthetic/anonymized WU066-shaped behavioral fixture, NOT ALFRAN product code.
// These executions validate the evidence workflow and sensitivity of the fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freezeCandidate } from '../../src/execution/candidate.js'
import { runCandidateVerification } from '../../src/execution/verification.js'

const implementation = `exports.seed = (rows, current = new Map()) => {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate source identity');
  const accepted = rows.filter(r => r.id <= 73);
  const extras = rows.filter(r => r.id > 73).map(r => r.id);
  const products = new Map(current);
  for (const row of accepted) if (!products.has(row.id)) products.set(row.id, { id: row.id, name: row.name, publicationState: 'DEFERRED', isActive: true });
  return { products, extras };
};`
const checks = `const a = require('node:assert/strict'), {seed} = require('./seed.cjs');
const rows = Array.from({length:88}, (_,i) => ({id:i+1,name:'SKU'+(i+1), NO_VENDER:true}));
const first = seed(rows);
a.equal(first.products.size,73, 'count73');
a.deepEqual(first.extras,Array.from({length:15},(_,i)=>i+74), 'extras reported');
a.ok([...first.products.values()].every(p=>p.publicationState==='DEFERRED'&&p.isActive), 'independent publication/lifecycle');
const edited = new Map(first.products); edited.set(1,{...edited.get(1),name:'Staff edit'});
const second = seed(rows,edited);
a.deepEqual(second.products,edited, 'idempotency and staff edits');
a.notEqual(second.products,edited, 'input not mutated');
a.throws(()=>seed([...rows,rows[0]]),/Duplicate/, 'source integrity');
`
const mutations = [
  ['extra-import', 'r.id <= 73', 'r.id <= 88', /count73/],
  ['silent-extras', 'const extras = rows.filter(r => r.id > 73).map(r => r.id)', 'const extras = []', /extras reported/],
  ['publish', "publicationState: 'DEFERRED'", "publicationState: 'PUBLISH'", /publication\/lifecycle/],
  ['inactive', 'isActive: true', 'isActive: false', /publication\/lifecycle/],
  ['overwrite-edit', 'if (!products.has(row.id))', 'if (true)', /idempotency and staff edits/],
  ['source-duplicate', "if (new Set(rows.map(r => r.id)).size !== rows.length)", 'if (false)', /source integrity/],
]

test('73 approved, 15 extras and staff edits: restored GREEN and six behavioral mutation failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'retrospective-seed-'))
  t.after(() => rm(root, {recursive:true,force:true}))
  await writeFile(join(root,'check.cjs'),checks)
  const run = async code => {
    await writeFile(join(root,'seed.cjs'),code)
    const candidate = await freezeCandidate(root,{paths:['seed.cjs','check.cjs'],verification_contract:{source_wu_id:'SYNTHETIC-WU066',commands:[{id:'behavior',program:'node',args:['check.cjs']}]}})
    return runCandidateVerification(candidate,'behavior')
  }
  assert.equal((await run(implementation)).status,'PASS')
  for (const [name, from, to, pattern] of mutations) {
    assert.ok(implementation.includes(from),name)
    const negative = await run(implementation.replace(from,to))
    assert.equal(negative.status,'FAIL',name)
    assert.match(negative.stderr,pattern,name)
    assert.equal(negative.timedOut,false)
  }
  assert.equal((await run(implementation)).status,'PASS')
})
