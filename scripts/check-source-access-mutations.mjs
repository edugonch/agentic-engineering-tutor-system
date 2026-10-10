// Focused guard mutations in isolated copies. Never changes the working tree.
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url).pathname
const mutations = [
  ['review-recheck', 'src/execution/readiness.js', '{ // No durable proof that stable requirements remain valid across phases.', 'if (phase === "BUILD") {', 'tests/execution/readiness.test.js'],
  ['read-method', 'src/external-source-reader.js', 'preview?.request?.method?.toUpperCase() !== "GET"', 'false', 'tests/project-source-access.test.js'],
  ['exact-source', 'src/external-source-reader.js', '!url.pathname.split("/").map(decodeURIComponent).includes(sourceId)', 'false', 'tests/project-source-access.test.js'],
  ['credential-restriction', 'src/external-source-reader.js', 'permissions: "read"', 'permissions: "admin"', 'tests/project-source-access.test.js'],
  ['secret-redaction', 'src/external-source-reader.js', 'JSON.parse(JSON.stringify(raw).split(original.apiKey).join("[REDACTED]"))', 'raw', 'tests/project-source-access.test.js'],
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
