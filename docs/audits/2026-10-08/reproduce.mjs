// Audit-only probes. All execution state and fake projects live in temporary
// directories. No network or live ALFRAN state is used. Assertions document
// observed defects, NOT desired production behavior.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExecutionController } from '../../../src/execution/controller-tool.js'
import { createExecutionController } from '../../../src/execution/execution.js'
import { recordKnowledgeArtifact } from '../../../src/project-knowledge.js'
import { freezeCandidate } from '../../../src/execution/candidate.js'
import { createCandidateRegistry } from '../../../src/execution/candidate-registry.js'
import { createVerificationReceipt, writeVerificationReceipt } from '../../../src/execution/verification-results.js'
import { runCandidateVerification, runCommand } from '../../../src/execution/verification.js'
import { runMergeCandidate } from '../../../src/execution/merge.js'
import { createTurnGuard } from '../../../src/turn-guard.js'
import { createLaunchBindingRegistry } from '../../../src/execution/launch-binding.js'
import { createGitHubAdapter } from '../../../src/execution/github-adapter.js'
import { checkExecutionReadiness } from '../../../src/execution/readiness.js'
const results=[]
async function probe(id, fn) {
 const root=await mkdtemp(join(tmpdir(),'harness-audit-'))
 try { results.push({id,...await fn(root)}) } finally { await rm(root,{recursive:true,force:true}) }
}
async function setup(root) {
 const run=(action,extra={})=>runExecutionController(root,{execution_id:'E1',session_id:'parent',action,...extra})
 await recordKnowledgeArtifact(root,{artifact_type:'epic',artifact_id:'EPIC',title:'Audit',status:'APPROVED',owner_confirmed:true,source_refs:['https://example.invalid/approval'],content:'execution_mandate: {"max_wus":4,"total_seconds":86400,"merge_policy":"governed_auto","required_ci_checks":["ci"]}'})
 await run('approve_mandate',{epic_artifact_id:'EPIC',mandate_id:'M1'})
 await recordKnowledgeArtifact(root,{artifact_type:'work-unit',artifact_id:'WU1',title:'WU1',status:'APPROVED',owner_confirmed:true,source_refs:['EPIC'],content:'Execution budget: 40 minutes (2400 seconds). One outcome.'})
 await run('activate_wu',{wu_id:'WU1',mandate_id:'M1'})
 const controller=await createExecutionController({dir:join(root,'.harness/execution/controller/E1')})
 return {run,controller}
}
async function ready(root,{verdict='PASS'}={}) {
 const f=await setup(root)
 const contract={source_wu_id:'WU1',commands:[{id:'check',program:'node',args:['-e','process.exit(0)']}]}
 await writeFile(join(root,'app.txt'),'reviewed bytes')
 const candidate=await freezeCandidate(root,{paths:['app.txt'],verification_contract:contract})
 const registry=createCandidateRegistry({dir:join(root,'.harness/execution')})
 await registry.store(candidate)
 await f.run('record_candidate',{candidate_id:candidate.candidate_id})
 const result=await runCandidateVerification(candidate,'check')
 const receipt=createVerificationReceipt(result)
 await writeVerificationReceipt(join(root,'.harness/execution/verification-results'),receipt)
 const review={candidate_id:candidate.candidate_id,verdict,reviewer:'reviewer',verification_evidence_ids:[receipt.evidence_id]}
 await f.run('record_review',review)
 const bind={candidate_id:candidate.candidate_id,repository:'audit/example',pr_number:1,head_sha:'arbitrary-head',base_branch:'main',base_sha:'base-a'}
 await f.run('bind_pr',bind)
 await f.run('record_ci',{candidate_id:candidate.candidate_id,head_sha:bind.head_sha,check_identity:'ci',conclusion:'SUCCESS'})
 return {...f,candidate,registry,review,bind}
}
function fakeRemote() {
 const state={conclusion:'SUCCESS',merged:false,calls:0,base:'base-a'}
 const adapter={getPullRequest:async()=>({head_sha:'arbitrary-head',base_sha:state.base,base_branch:'main',state:'open',merged:state.merged,merge_commit_sha:state.merged?'merge-sha':null}),getChecks:async()=>[{name:'ci',conclusion:state.conclusion}],merge:async()=>{state.calls++;state.merged=true;return {merged:true,merge_commit_sha:'merge-sha'}}}
 return {state,adapter}
}
await probe('A01_nominal_budget',async root=>{
 const {run}=await setup(root)
 await run('reserve',{dispatch_id:'d1',reserved_seconds:3600})
 await run('record_launch',{dispatch_id:'d1',launch_session_id:'child'})
 await run('record_finish',{dispatch_id:'d1',result:'finished after a short inspection'})
 const r=await run('reconcile',{dispatch_id:'d1'})
 assert.equal(r.budget.used_seconds,3600);assert.equal(r.wu_budget.ceiling_seconds,null)
 return {used_seconds:r.budget.used_seconds,original_wu_contract_seconds:2400,loaded_wu_ceiling:r.wu_budget.ceiling_seconds,verify:(await run('verify')).passed}
})
await probe('A02_release_binding',async root=>{
 const {run}=await setup(root);const bindings=createLaunchBindingRegistry()
 await run('reserve',{dispatch_id:'d',reserved_seconds:10})
 await run('prepare_launch',{dispatch_id:'d',launch_agent:'harness-builder'})
 bindings.set('parent','harness-builder',{execution_id:'E1',dispatch_id:'d'})
 await run('release',{dispatch_id:'d'})
 assert.ok(bindings.peek('parent','harness-builder'))
 return {durable_status:(await run('status')).dispatches[0].status,ephemeral_binding_remaining:true,note:'Composes registry and controller as index.js does; no real OpenCode runtime'}
})
await probe('A03_review_update',async root=>{
 const f=await ready(root,{verdict:'CHANGES_REQUIRED'})
 let error;try {await f.run('record_review',{...f.review,verdict:'PASS'})}catch(e){error=e.message}
 assert.match(error,/reused with different content/)
 return {error}
})
await probe('A04_merge_resume_blocker',async root=>{
 const f=await ready(root);const remote=fakeRemote();remote.state.conclusion='FAILURE'
 await assert.rejects(runMergeCandidate(root,{candidate_id:f.candidate.candidate_id,session_id:'parent',adapter:remote.adapter}),/required CI/)
 assert.equal((await f.run('status')).merge.status,'STARTED')
 await f.run('block',{class:'BLOCKED_SECURITY',reason:'new security stop before retry'})
 remote.state.conclusion='SUCCESS'
 const result=await runMergeCandidate(root,{candidate_id:f.candidate.candidate_id,session_id:'parent',adapter:remote.adapter})
 assert.equal(remote.state.calls,1)
 return {merge_result:result.status,remote_merge_calls:remote.state.calls,blocker_after:(await f.run('status')).blocker.class,note:'Fake remote; no external merge'}
})
await probe('A05_same_candidate_rebind',async root=>{
 const f=await ready(root)
 let error;try {await f.run('bind_pr',{...f.bind,base_sha:'base-b'})}catch(e){error=e.message}
 assert.match(error,/already bound|reused with different content/)
 const again=await freezeCandidate(root,{paths:['app.txt'],verification_contract:f.candidate.verification_contract})
 assert.equal(again.candidate_id,f.candidate.candidate_id)
 return {error,refreeze_same_bytes_same_id:true}
})
await probe('A06_started_merge_blocks_repair',async root=>{
 const f=await ready(root);const remote=fakeRemote();remote.state.conclusion='FAILURE'
 await assert.rejects(runMergeCandidate(root,{candidate_id:f.candidate.candidate_id,session_id:'parent',adapter:remote.adapter}))
 await writeFile(join(root,'app.txt'),'corrected bytes')
 const replacement=await freezeCandidate(root,{paths:['app.txt'],verification_contract:f.candidate.verification_contract})
 await f.registry.store(replacement);await f.run('record_candidate',{candidate_id:replacement.candidate_id})
 const r=createVerificationReceipt(await runCandidateVerification(replacement,'check'))
 await writeVerificationReceipt(join(root,'.harness/execution/verification-results'),r)
 await f.run('record_review',{candidate_id:replacement.candidate_id,verdict:'PASS',verification_evidence_ids:[r.evidence_id]})
 let error;try {await f.run('bind_pr',{...f.bind,candidate_id:replacement.candidate_id,head_sha:'new-head'})}catch(e){error=e.message}
 assert.match(error,/already bound|reused with different content/)
 return {error,merge_state:(await f.run('status')).merge.status}
})
await probe('A07_workspace_dependencies',async root=>{
 await mkdir(join(root,'node_modules/audit-local-dep'),{recursive:true})
 await writeFile(join(root,'node_modules/audit-local-dep/index.js'),'module.exports=42')
 await writeFile(join(root,'test.cjs'),"require('audit-local-dep')")
 const local=await runCommand('node',['test.cjs'],{cwd:root})
 assert.equal(local.ok,true)
 const candidate=await freezeCandidate(root,{paths:['test.cjs'],verification_contract:{commands:[{id:'test',program:'node',args:['test.cjs']}]}})
 const frozen=await runCandidateVerification(candidate,'test')
 assert.equal(frozen.status,'FAIL');assert.match(frozen.stderr,/Cannot find module/)
 return {checkout:local.ok?'PASS':'FAIL',candidate:frozen.status,reason:'Dependency exists in checkout but disposable workspace has no provisioning phase'}
})
await probe('A08_no_progress_external_change',async()=>{
 const guard=createTurnGuard();const args={candidate_id:'same'}
 for(let i=0;i<2;i++)await assert.rejects(guard.runHarness('p','harness_merge_candidate',args,async()=>{throw Error('CI pending')}))
 let invoked=false;let error
 try{await guard.runHarness('p','harness_merge_candidate',args,async()=>{invoked=true;return {status:'merged'}})}catch(e){error=e.code}
 assert.equal(invoked,false);assert.equal(error,'HARNESS_NO_PROGRESS')
 return {external_condition_now_ready:true,third_attempt_invoked:invoked,error}
})
await probe('A09_verify_event_integrity',async root=>{
 const {run}=await setup(root);await run('block',{class:'BLOCKED_TOOLING',reason:'original'})
 const path=join(root,'.harness/execution/controller/E1/events.ndjson')
 const events=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse)
 events.at(-1).body.reason='modified without recomputing operation_hash'
 await writeFile(path,events.map(JSON.stringify).join('\n')+'\n')
 const r=await run('verify');assert.equal(r.passed,true)
 return {modified_event_hash_not_recomputed:true,verify:r.passed,note:'Tampering is confined to disposable audit fixture'}
})
await probe('A10_complete_then_dispatch',async root=>{
 const {run}=await setup(root)
 // Use separate diagnostic init fixture so the public complete action has no active WU.
 const call=(action,extra={})=>runExecutionController(root,{execution_id:'probe',session_id:'parent',action,...extra})
 await call('init',{total_seconds:100});await call('complete',{result:'done'})
 const r=await call('reserve',{dispatch_id:'after-complete',reserved_seconds:10})
 assert.equal(r.completed,true);assert.equal(r.dispatches.length,1)
 return {completed:r.completed,dispatch_after_completion:r.dispatches[0].status,note:'Public init/probe execution; missing terminal guard also visible in applyEvent'}
})
await probe('A11_readiness_budget_zero',async()=>{
 const r=await checkExecutionReadiness({contract:{commands:[{id:'x',program:'node',args:[]}]},probe:async()=>({status:'READY'}),budget:{remaining:0}})
 assert.equal(r.status,'READY')
 return {status:r.status,budget:r.budget,note:'index.js supplies remaining only; build/review reserves default to zero'}
})
await probe('A12_ci_rerun_selection',async()=>{
 const adapter=createGitHubAdapter({fetchImpl:async()=>({ok:true,json:async()=>({check_runs:[{name:'ci',conclusion:'success',id:2},{name:'ci',conclusion:'failure',id:1}]})})})
 const r=await adapter.getChecks({repository:'audit/example',head_sha:'head',check_names:['ci']})
 assert.equal(r[0].conclusion,'failure')
 return {latest_supplied:'success',selected:r[0].conclusion,note:'Synthetic API response, no network; last name wins independent of run id'}
})
await probe('A13_candidate_head_binding',async root=>{
 const f=await ready(root);const remote=fakeRemote()
 const r=await runMergeCandidate(root,{candidate_id:f.candidate.candidate_id,adapter:remote.adapter,session_id:'parent'})
 assert.equal(r.status,'merged')
 return {status:r.status,bound_head:f.bind.head_sha,tree_check_supported_by_adapter:false,note:'Fake remote: reviewed tree is never compared with PR head contents'}
})
console.log(JSON.stringify({audit_commit:'f094b038f1f036a55eb6f375fcac6d15678c8792',probes:results},null,2))
