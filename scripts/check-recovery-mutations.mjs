// Focused guard mutations in isolated copies. Never changes the working tree.
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url).pathname
const mutations = [
  ['process-acceptance', 'src/execution/process-recovery.js', "if (recovery && (recovery.status !== 'ACCEPTED' || recovery.candidate_id !== candidateId))", 'if (false)', 'tests/execution/process-recovery.test.js'],
  ['legacy-scope', 'src/execution/process-recovery.js', 'p.legacy_blocker_hashes.includes(blockerFingerprint(state.blocker))', 'true', 'tests/execution/process-recovery.test.js'],
  ['review-attribution', 'src/execution/process-recovery.js', "d.expected_agent !== 'harness-reviewer'", 'false', 'tests/execution/process-recovery.test.js'],
  ['cumulative-context', 'src/execution/process-recovery.js', 'state.authority_resolutions?.[state.wu?.wu_id] ?? []', '(state.authority_resolutions?.[state.wu?.wu_id] ?? []).slice(-1)', 'tests/execution/process-recovery.test.js'],
  ['pending-ci', 'src/execution/external-observation.js', "return required.every(name => {", 'return true || required.every(name => {', 'tests/execution/external-wait.test.js'],
  ['delegated-gates', 'src/execution/contract-correction.js', 'before.commands.some(check => !after.commands.some(nextCheck => stableHash(check) === stableHash(nextCheck)))', 'false', 'tests/execution/contract-correction.test.js'],
  ['evidence-set', 'src/execution/process-recovery.js', 'd.process_evidence_hash !== stableHash(r.evidence)', 'false', 'tests/execution/process-recovery.test.js'],
]
const baseline = spawnSync(process.execPath, ['--test', ...new Set(mutations.map(m => m[4]))], { cwd: root, encoding: 'utf8', timeout: 60000 })
if (baseline.status !== 0) throw new Error('Mutation baseline must pass first: ' + baseline.stdout + baseline.stderr)
const results = []
for (const [name, file, from, to, suite] of mutations) {
  const copy = await mkdtemp(join(tmpdir(), 'harness-mutation-'))
  try {
    for (const path of ['src','tests','package.json']) await cp(join(root,path),join(copy,path),{recursive:true})
    const path = join(copy,file), original = await readFile(path,'utf8')
    if (!original.includes(from)) throw new Error(`Mutation target absent: ${name}`)
    await writeFile(path,original.replace(from,to))
    const result = spawnSync(process.execPath,['--test',suite],{cwd:copy,encoding:'utf8',timeout:30000})
    const output = result.stdout + result.stderr
    const killed = result.status === 1 && /(?:✖|not ok)/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output)
    results.push({name,killed,exit_code:result.status})
    console.log(JSON.stringify(results.at(-1)))
  } finally { await rm(copy,{recursive:true,force:true}) }
}
if (results.some(r=>!r.killed)) process.exitCode = 1
