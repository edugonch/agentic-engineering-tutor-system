import { Plugin } from "@opencode/plugin"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { resolveBinary } from "./src/resolve-binary.js"
import { applyOutputTokenCap, createTurnGuard, readGuardSettings } from "./src/turn-guard.js"
import { getProjectStatus, initializeProject } from "./src/scaffold.js"
import { analyzeExistingProject } from "./src/project-analysis.js"
import { validateStoryFile } from "./src/story-validator.js"
import { checkWorkUnitAgentReadiness, guardHarnessSubagentPermission } from "./src/agent-readiness.js"
import { recordArtifactWithActivationGate } from "./src/activation-gate.js"
import { provisionGlobalHarnessAgents, resolveOpenCodeConfigDir } from "./src/global-agent-provisioner.js"
import { searchKnowledge } from "./src/knowledge-search.js"
import { discoverProjectKnowledge, importProjectKnowledge, readProjectKnowledge, recordKnowledgeArtifact, searchProjectKnowledge } from "./src/project-knowledge.js"
import { registerHarnessCommand } from "./src/bootstrap-command.js"
import {
  buildAuditRecord,
  createAuditSink,
  createDecisionProvider,
  createJevDecisionProvider,
  createShadowPolicy,
  isJevReady,
  readJevSettings,
} from "./src/decision/index.js"
import { runContinuationProbe, createContinuationDriver, createCandidateRegistry, captureBaseSnapshot, freezeCandidate, runCandidateVerification, checkExecutionReadiness, pathDigest, validateVerificationContract, runExecutionController, claimDispatchLaunch, createLaunchBindingRegistry, createVerificationReceipt, writeVerificationReceipt, createGitHubAdapter, runMergeCandidate, BLOCKER_CLASSES, CI_CONCLUSIONS } from "./src/execution/index.js"

const json = (value) => ({ content: JSON.stringify(value, null, 2) })
const objectInput = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

function detectBrowser() {
  return BROWSER_CANDIDATES.some((candidate) => { try { return existsSync(candidate) } catch { return false } })
}

export default Plugin.define({
  id: "opencode.agentic-harness",
  async setup(ctx) {
    const settings = readGuardSettings(process.env)
    const guard = createTurnGuard(settings)
    const continuation = createContinuationDriver(ctx)
    // Wave B launch-claim registry (in-memory, ephemeral, single-use): maps a
    // controller session + the agent it prepared to launch, to the exact
    // execution_id + dispatch_id. It exists only to bind the next subagent launch
    // to its prepared dispatch at the execute.before boundary. A binding is
    // consumed exactly once; a second prepare for the same key is rejected. If the
    // process dies after prepare_launch but before the subagent, the registry is
    // lost and the durable dispatch remains unclaimed (releasable). It never
    // replaces the durable log.
    const launchBindings = createLaunchBindingRegistry()
    const eventSubscription = new AbortController()
    const projectRoot = ctx.location?.project?.canonical
    const requireProjectRoot = () => {
      if (!projectRoot) throw new Error("OpenCode did not provide this plugin location's canonical project root.")
      return projectRoot
    }

    const candidateRegistry = createCandidateRegistry({ dir: join(requireProjectRoot(), ".harness", "execution") })

    // AgentEditor can update existing agents but cannot add new definitions.
    // Keep the Harness roles available by managing their global profile files
    // as part of plugin load/update, then refresh OpenCode's runtime registry.
    let agentProvisioning
    try {
      agentProvisioning = await provisionGlobalHarnessAgents({
        packageRoot: fileURLToPath(new URL(".", import.meta.url)),
        configDir: resolveOpenCodeConfigDir(process.env),
      })
      if (agentProvisioning.changed) await ctx.agent.reload()
    } catch (error) {
      agentProvisioning = {
        status: "failed",
        created: [],
        updated: [],
        preserved: [],
        error: error?.message ?? "Global Harness agent provisioning failed.",
      }
    }

    const currentWorkUnitAgentReadiness = async () => ({
      ...(await checkWorkUnitAgentReadiness(ctx.agent)),
      profile_provisioning: agentProvisioning,
    })

    // Jev shadow-mode decision experiment. Disabled by default; opt-in via
    // HARNESS_JEV_ENABLED=1 and HARNESS_JEV_API_KEY. Jev estimates are audited
    // but never change routing, context, permissions, or actions.
    const jevSettings = readJevSettings(process.env)
    const jevProvider = isJevReady(jevSettings)
      ? createDecisionProvider(createJevDecisionProvider(jevSettings))
      : null
    const jevPolicy = createShadowPolicy()
    const jevAudit = createAuditSink(jevSettings, projectRoot)
    const jevSeen = new Set()
    const JEV_SEEN_MAX = 1000

    function jevTaskId(sessionID, messageID) {
      return `${sessionID}::${messageID}`
    }

    function markJevSeen(messageID) {
      if (jevSeen.size >= JEV_SEEN_MAX) {
        const first = jevSeen.values().next().value
        jevSeen.delete(first)
      }
      jevSeen.add(messageID)
    }

    async function runJevShadow(event) {
      const taskId = jevTaskId(event.sessionID, event.messageID)
      const state = String(event.prompt?.text ?? "").slice(0, 2000)
      const result = await jevProvider.estimate({ taskId, state })
      if (result.ok) {
        // Policy is intentionally a no-op in shadow mode.
        jevPolicy.apply(result.signals)
      }
      const record = buildAuditRecord({
        taskId,
        requestedModel: jevSettings.model,
        actualModel: result.ok ? result.actualModel : undefined,
        signals: result.ok ? result.signals : undefined,
        usage: result.ok ? result.usage : undefined,
        latencyMs: result.latencyMs,
        status: result.ok ? "ok" : "error",
        error: result.error,
      })
      await jevAudit.write(record)
    }

    // A fresh user prompt starts a new per-session action budget.
    await ctx.session.hook("prompt", (event) => {
      if (!continuation.isInternalPrompt(event.sessionID)) {
        guard.reset(event.sessionID)
      }

      // Shadow-mode Jev: one best-effort estimate per admitted user prompt.
      // Prompt hooks are not an exactly-once boundary; we key by messageID to
      // avoid duplicate calls when admission is retried.
      if (jevProvider && event.messageID && !jevSeen.has(event.messageID)) {
        markJevSeen(event.messageID)
        // Fire and forget: failures must never block prompt admission or alter
        // the conversation.
        runJevShadow(event).catch(() => {})
      }
    })

    // V2 calls this hook before every agent-loop request, including tool continuations.
    await ctx.session.hook("context", (event) => {
      applyOutputTokenCap(event.options, settings.maxOutputTokens)
      continuation.onContext(event)
    })

    // Allow at most one retry after the initial provider request.
    await ctx.session.hook("retry", (event) => {
      if (event.attempt >= 2) event.decision = { retry: false }
    })

    // Count tool calls and delegations for the session that actually ran them,
    // and (Wave B) claim a bound prepared dispatch at the launch boundary.
    await ctx.tool.hook("execute.before", async (event) => {
      // Run the circuit breaker first. If it trips, the subagent is rejected and
      // no claim is written — the pre-side-effect failure stays NEVER_LAUNCHED and
      // releasable (this is the WU-058 case, now structural).
      guard.before(
        { sessionID: event.sessionID, tool: event.tool },
        { args: event.input },
      )

      // Launch-claim boundary: only after the guard passes, durably record the
      // claim for the bound dispatch BEFORE OpenCode executes the subagent. A
      // crash after this point is AMBIGUOUS, never never-launched.
      if (event.tool === "subagent") {
        const agent = event.input?.agent
        if (agent) {
          // Consume exactly once: remove the binding BEFORE attempting the
          // durable claim. If the claim fails, the subagent does not execute and
          // no stale binding remains to re-claim the same dispatch later.
          const binding = launchBindings.consume(event.sessionID, agent)
          if (binding) {
            const callId = String(event.id ?? "")
            if (!callId) {
              throw new Error("Launch claim requires a tool call identity (event.id); the subagent launch is blocked.")
            }
            await claimDispatchLaunch(requireProjectRoot(), {
              execution_id: binding.execution_id,
              dispatch_id: binding.dispatch_id,
              call_id: callId,
              session_id: event.sessionID,
            })
          }
        }
      }
    })

    // Enforce the runtime prerequisite at the actual OpenCode permission
    // boundary too. Prompt instructions and a read-only preflight are not a
    // delegation guard; an unavailable Harness role must be denied here.
    await ctx.permission.hook("evaluate", async (event) => {
      await guardHarnessSubagentPermission(event, ctx.agent)
      // D2 hard-stop primitive: a registered probe session requesting a
      // forbidden action is denied and blocked; the driver never continues it
      // and never evades the denial through another route.
      if (continuation.isForbiddenProbeAction(event.action) && continuation.getProbe(event.sessionID)) {
        event.effect = "deny"
        event.message = "BLOCKED_PERMISSION: this probe action is denied by the Phase 0 hard-stop primitive."
        continuation.markBlocked(event.sessionID, `permission.rejected:${event.action}`)
      }
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "harness_initialize_project",
        description: "Create missing Harness governance, OpenCode agents, and skills in the current canonical project. Call only after the owner has reviewed and explicitly approved the project summary. Never overwrite existing files.",
        input: objectInput({
          project_type: { type: "string", enum: ["new", "existing"] },
          project_name: { type: "string", minLength: 1 },
          initialization_scope: { type: "string", enum: ["full", "governance_only"], default: "full", description: "Use governance_only when the owner authorized project governance but not the supporting Harness agents, skills, or OpenCode config." },
          problem: { type: "string", minLength: 1 },
          desired_outcome: { type: "string", minLength: 1 },
          mvp: { type: "string", minLength: 1 },
          success_evidence: { type: "string", minLength: 1 },
          import_assessment: { type: "string", maxLength: 20000 },
          project_story_ref: { type: "string", maxLength: 1000, description: "Exact existing local path or canonical external ID/URI for the live story authority, when present." },
          project_state_ref: { type: "string", maxLength: 1000, description: "Exact existing local path or canonical external ID/URI for the live state authority, when present." },
          owner_confirmed: { type: "boolean" },
        }, ["project_type", "project_name", "problem", "desired_outcome", "mvp", "success_evidence", "owner_confirmed"]),
        execute: async (input) => {
          if (!input.owner_confirmed) {
            return { content: "Initialization stopped: obtain explicit owner approval of the project summary, then call again with owner_confirmed=true. No files were written." }
          }
          if (input.project_type === "existing" && !input.import_assessment?.trim()) {
            return { content: "Initialization stopped: include the owner-approved import mapping and evidence summary in import_assessment. No files were written." }
          }
          return json(await initializeProject(requireProjectRoot(), input))
        },
      })

      editor.add({
        name: "harness_analyze_existing_project",
        description: "Read-only bounded inventory for bringing an existing software project under Harness governance. Reports project markers and likely story, Epic, Work Unit, research, and decision documents; never reads file contents or changes files.",
        input: objectInput({}),
        execute: async () => json(await analyzeExistingProject(requireProjectRoot())),
      })

      editor.add({
        name: "harness_discover_project_knowledge",
        description: "Read-only inventory of research, compendia, syntheses, rules, decisions, specs, stories, Epics, WUs, and other likely knowledge in the current project. Reports paths and metadata only; never reads document bodies or changes files.",
        input: objectInput({}),
        execute: async () => json(await discoverProjectKnowledge(requireProjectRoot())),
      })

      editor.add({
        name: "harness_import_project_knowledge",
        description: "After explicit owner approval, archive discovered local project knowledge, transfer an existing Harness knowledge archive from another local project, and import exact-revision external source snapshots. Preserves bytes, hashes, IDs, revisions, retrieval time, classifications, declared authority, and remapped relationships. Snapshots are unverified references and do not replace live authority.",
        input: objectInput({
          owner_confirmed: { type: "boolean" },
          source_project_root: { type: "string", minLength: 1 },
          source_project_id: { type: "string", minLength: 1, maxLength: 181 },
          external_sources: {
            type: "array", maxItems: 20,
            items: objectInput({
              source_id: { type: "string", minLength: 1, maxLength: 181 },
              source_record_key: { type: "string", minLength: 1, maxLength: 181 },
              title: { type: "string", minLength: 1 },
              source_system: { type: "string", enum: ["google-drive", "github", "other"] },
              source_ref: { type: "string", minLength: 1 },
              source_revision: { type: "string", minLength: 1 },
              retrieved_at: { type: "string" },
              classification: { type: "string", enum: ["PROJECT_STATE", "GOVERNANCE_RULE", "APPROVED_DECISION", "REQUIREMENT", "SPECIFICATION", "EPIC", "USER_STORY", "WORK_UNIT", "RAW_RESEARCH", "RESEARCH_COMPENDIUM", "RESEARCH_SYNTHESIS", "DESIGN_HANDOFF", "REFERENCE", "OTHER"] },
              disposition: { type: "string", enum: ["UNASSESSED", "APPLIED", "NOT_APPLIED", "TANGENTIAL", "DISCARDED", "DEFERRED", "SUPERSEDED"] },
              declared_authority: { type: "string", enum: ["CANONICAL", "APPROVED", "DERIVED", "RAW", "HISTORICAL", "UNKNOWN"] },
              content: { type: "string", minLength: 1, maxLength: 1048576 },
              related_sources: { type: "array", items: { type: "string" }, maxItems: 100 },
            }, ["source_id", "title", "source_system", "source_ref", "source_revision", "classification", "declared_authority", "content"]),
          },
        }, ["owner_confirmed"]),
        execute: async (input) => json(await importProjectKnowledge(requireProjectRoot(), input)),
      })

      editor.add({
        name: "harness_search_project_knowledge",
        description: "Search the project's imported research and governance snapshots on demand. Returns short excerpts with source ID, exact revision, authority declaration, hash, resolved relationships, and unresolved source references. Search is a navigation aid; verify current authority before relying on a result.",
        input: objectInput({
          query: { type: "string", minLength: 3, maxLength: 500 },
          max_results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        }, ["query"]),
        execute: async (input) => json(await searchProjectKnowledge(requireProjectRoot(), input.query, input.max_results)),
      })

      editor.add({
        name: "harness_read_project_knowledge",
        description: "Read one exact imported project-knowledge source by source_id or record_key returned by the index/search tool. For multiple revisions, pass the record_key. Returns bounded lines and provenance.",
        input: objectInput({
          source_id: { type: "string", minLength: 1 },
          start_line: { type: "integer", minimum: 1, default: 1 },
          max_lines: { type: "integer", minimum: 1, maximum: 500, default: 200 },
        }, ["source_id"]),
        execute: async (input) => json(await readProjectKnowledge(requireProjectRoot(), input.source_id, input.start_line, input.max_lines)),
      })

      editor.add({
        name: "harness_record_knowledge_artifact",
        description: "After the owner authorizes this artifact write, persist a research record, compendium, synthesis, requirement, specification, user story, Epic, WU, decision, or rule as a new immutable artifact with source/parent references. Epics and WUs are written to .harness/epics/ and .harness/work-units/; other artifacts use the knowledge archive. Safe existing project-relative files are valid source references. Requires explicit provenance; APPROVED status requires owner confirmation, and research evidence cannot itself be marked approved. Approved WU activation decisions are rejected unless harness-builder and harness-reviewer are available in OpenCode's runtime registry.",
        input: objectInput({
          artifact_type: { type: "string", enum: ["raw-research", "research-compendium", "research-synthesis", "requirement", "specification", "user-story", "epic", "work-unit", "decision", "rule"] },
          artifact_id: { type: "string", minLength: 1, maxLength: 181 },
          title: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1, maxLength: 524288 },
          status: { type: "string", enum: ["RAW", "DRAFT", "PROPOSED", "APPROVED", "REJECTED", "SUPERSEDED"] },
          source_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
          parent_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
          owner_confirmed: { type: "boolean" },
        }, ["artifact_type", "artifact_id", "title", "content", "status", "owner_confirmed"]),
        execute: async (input) => json(await recordArtifactWithActivationGate(
          requireProjectRoot(), input, ctx.agent, recordKnowledgeArtifact,
        )),
      })

      editor.add({
        name: "harness_project_status",
        description: "Read the current canonical project's Harness scaffold and check whether the required builder and reviewer are currently loaded by OpenCode. Missing or unknown roles block Work Unit activation and delegation. Never edits files.",
        input: objectInput({}),
        execute: async () => {
          const projectStatus = await getProjectStatus(requireProjectRoot())
          const workUnitAgentReadiness = await currentWorkUnitAgentReadiness()
          return json({
            ...projectStatus,
            work_unit_agent_readiness: workUnitAgentReadiness,
            next: workUnitAgentReadiness.ready
              ? projectStatus.next
              : "Work Unit execution is blocked: review the global profile provisioning result and restore required agent availability before proposing or recording activation. Do not manually copy project profiles or widen the approved project initialization scope.",
          })
        },
      })

      editor.add({
        name: "harness_check_agent_readiness",
        description: "Read-only preflight of OpenCode's currently loaded agent registry. Call before proposing/recording Work Unit activation and again before delegation. Requires harness-builder and harness-reviewer to be available as subagents. A blocked or unknown result means do not activate or delegate; a permission hook also denies attempts to launch either role. This tool never installs agents or edits files.",
        input: objectInput({}),
        execute: async () => json(await currentWorkUnitAgentReadiness()),
      })

      editor.add({
        name: "harness_validate_story",
        description: "Validate an Epic or Work Unit Markdown contract for required finite boundaries and story relationships. PASS is structural only; inspect activation_ready and activation_blockers for owner approvals and execution budgets. The path must be relative to the canonical project root. Never edits files.",
        input: objectInput({
          document_path: { type: "string", minLength: 1 },
          document_type: { type: "string", enum: ["epic", "wu"] },
        }, ["document_path", "document_type"]),
        execute: async (input) => json(await validateStoryFile(requireProjectRoot(), input.document_path, input.document_type)),
      })

      editor.add({
        name: "harness_search_knowledge",
        description: "Search the plugin's preserved, user-supplied agent/skill/plugin reference library. Returns at most five short, ranked excerpts with source paths and line ranges; does not inject or return the whole corpus. Treat excerpts as non-authoritative evidence and verify platform-specific claims against current official documentation.",
        input: objectInput({
          query: { type: "string", minLength: 3, maxLength: 500, description: "One specific question or concept to find in the preserved reference library." },
          source_id: { type: "string", pattern: "^SRC-(0[1-9]|1[0-7])$", description: "Optional source ID filter, for example SRC-03." },
          max_results: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        }, ["query"]),
        execute: async (input) => json(await searchKnowledge(input.query, input)),
      })

      editor.add({
        name: "harness_continuation_probe",
        description: "Phase 0 spike instrument. Drives an isolated continuation experiment under .harness/execution/probe/<probe_id>/: init approves an execution mandate and records a checkpoint; checkpoint settles billable phase time; verify reports the invariant matrix (stable execution/mandate/WU identity, non-resetting budget, no duplicate dispatch, monotonic fencing token, no synthesized approval, no unexpected blocker). It never edits OpenCode config, permissions, or agents, and never simulates the model.",
        input: objectInput({
          action: { type: "string", enum: ["init", "checkpoint", "verify", "block"], default: "verify" },
          probe_id: { type: "string", minLength: 1 },
          session_id: { type: "string", minLength: 1, description: "OpenCode session ID holding the execution lease." },
          mandate_id: { type: "string", minLength: 1 },
          mandate_revision: { type: "string", minLength: 1 },
          max_wus: { type: "integer", minimum: 1 },
          total_seconds: { type: "number", exclusiveMinimum: 0 },
          note: { type: "string" },
        }, ["action", "probe_id"]),
        execute: async (input) => json(await runContinuationProbe(requireProjectRoot(), input)),
      })

      editor.add({
        name: "harness_continuation_spike",
        description: "Phase 0 spike instrument for the continuation driver. Registers a probe session (steps + optional sentinel), marks a permission blocker, or reports the driver's per-session state (step count, continuations used, blocked). Mutates only the in-memory driver; never touches files or OpenCode config. Enabled by default; set HARNESS_CONTINUATION_ENABLED=0 to force off.",
        input: objectInput({
          action: { type: "string", enum: ["register", "block", "status"] },
          session_id: { type: "string", minLength: 1 },
          steps: { type: "integer", minimum: 1 },
          sentinel: { type: "string" },
        }, ["action"]),
        execute: async (input) => {
          if (!continuation.enabled) {
            return json({ enabled: false, note: "Continuation driver is disabled (HARNESS_CONTINUATION_ENABLED=0)." })
          }
          if (input.action === "register") {
            if (!input.session_id || !input.steps) throw new Error("register requires session_id and steps.")
            return json(continuation.registerProbe({ sessionID: input.session_id, steps: input.steps, sentinel: input.sentinel }))
          }
          if (input.action === "block") {
            if (!input.session_id) throw new Error("block requires session_id.")
            return json(continuation.markBlocked(input.session_id))
          }
          return json({
            enabled: true,
            max_continuations: continuation.maxContinuations,
            probes: input.session_id
              ? [continuation.getProbe(input.session_id)].filter(Boolean)
              : continuation.listProbes(),
            subscription_errors: continuation.getSubscriptionErrors(),
            recent_events: continuation.listEvents(),
            guard_snapshot: input.session_id ? guard.snapshot(input.session_id) : null,
          })
        },
      })

      editor.add({
        name: "harness_execution_controller",
        description: "Phase 2 durable execution control surface. Drives the recoverable execution machine under .harness/execution/controller/<execution_id>/. Dispatch actions: init (approve a mandate), reserve, prepare_launch, record_launch, mark_ambiguous, record_finish, reconcile, release, recover (read-only classification), status, verify (read-only invariant check). WU lifecycle actions (Phase 3): activate_wu, record_candidate (loads the candidate from the registry; the caller cannot supply hashes), record_review, complete_wu (WU close), checkpoint, block. complete remains Epic-level (EPIC_EXECUTION_VERIFIED). It is instrumentation, not new authority: every mutation routes through the controller commit path with operation_id + expected_revision + lease fencing. It never writes state.json or the event log directly, never edits OpenCode config/permissions/agents, and never simulates the model. Use verify after any restart to prove the durable core is intact.",
        input: objectInput({
          action: { type: "string", enum: ["init", "approve_mandate", "status", "reserve", "prepare_launch", "record_launch", "mark_ambiguous", "record_finish", "recover", "reconcile", "release", "verify", "activate_wu", "record_candidate", "record_review", "complete_wu", "checkpoint", "block", "bind_pr", "record_ci", "complete"], default: "status" },
          execution_id: { type: "string", minLength: 1, description: "Stable isolation key; durable state lives under .harness/execution/controller/<execution_id>/." },
          session_id: { type: "string", minLength: 1, description: "OpenCode session ID holding the execution lease (required for mutations)." },
          mandate_id: { type: "string", minLength: 1 },
          mandate_revision: { type: "string", minLength: 1 },
          epic_artifact_id: { type: "string", minLength: 1, description: "APPROVED Epic artifact id/record_key in the knowledge index (approve_mandate)." },
          max_wus: { type: "integer", minimum: 1 },
          total_seconds: { type: "number", exclusiveMinimum: 0 },
          dispatch_id: { type: "string", minLength: 1 },
          reserved_seconds: { type: "number", minimum: 0 },
          launch_agent: { type: "string", minLength: 1, description: "Agent the orchestrator is about to launch (prepare_launch); enables the runtime launch-claim boundary." },
          launch_session_id: { type: "string", minLength: 1, description: "External identity persisted at record_launch (distinct from the lease-holding session_id)." },
          result: { type: "string", description: "Opaque result attached at record_finish, complete (Epic), or complete_wu." },
          wu_id: { type: "string", minLength: 1 },
          candidate_id: { type: "string", minLength: 1, description: "Content-addressed candidate id already stored in the candidate registry; record_candidate loads it and derives authoritative hashes." },
          verdict: { type: "string" },
          verification_evidence_ids: { type: "array", items: { type: "string" }, description: "Durable evidence receipts (verify-<hash>) from harness_run_verification, bound to the candidate and PASS." },
          reviewer: { type: "string" },
          checkpoint_id: { type: "string", minLength: 1, description: "Explicit checkpoint key so repeated checkpoints do not collide on the operation id." },
          note: { type: "string", description: "Checkpoint note (checkpoint action only)." },
          class: { type: "string", enum: [...BLOCKER_CLASSES], description: "Typed blocker class (block action); must be a BLOCKER_CLASSES value." },
          reason: { type: "string", minLength: 1, description: "Human-readable reason (block)." },
          repository: { type: "string", minLength: 1, description: "GitHub repository (owner/name) bound by bind_pr." },
          pr_number: { type: "integer", minimum: 1, description: "GitHub PR number bound by bind_pr." },
          head_sha: { type: "string", minLength: 1, description: "Exact reviewed head SHA (bind_pr, record_ci)." },
          base_branch: { type: "string", minLength: 1, description: "Target base branch (bind_pr)." },
          base_sha: { type: "string", minLength: 1, description: "Expected base SHA at bind time (bind_pr); checked against merge-time base in the merge policy." },
          check_identity: { type: "string", minLength: 1, description: "CI check identity recorded by record_ci." },
          conclusion: { type: "string", enum: [...CI_CONCLUSIONS], description: "CI conclusion recorded by record_ci; one of SUCCESS/FAILURE/PENDING/ERROR." },
          evidence_ref: { type: "string", description: "Optional CI evidence reference (run id/URL) recorded by record_ci." },
        }, ["action", "execution_id"]),
        execute: async (input, context) => {
          // Reject a second prepare for the same session+agent BEFORE the durable
          // mutation, so a pending binding can never be silently overwritten (and
          // strand an already-prepared dispatch).
          if (input.action === "prepare_launch" && input.launch_agent) {
            const sid = context?.sessionID ?? input.session_id
            const agent = String(input.launch_agent)
            if (sid && launchBindings.peek(sid, agent)) {
              throw new Error(`A launch binding is already pending for ${agent}; consume or release it before preparing another launch.`)
            }
          }
          const result = await runExecutionController(requireProjectRoot(), input, candidateRegistry)
          // Wave B: after a successful prepare_launch with a named launch_agent,
          // register the ephemeral launch binding so the runtime can claim the
          // exact dispatch at the execute.before boundary of the next subagent.
          if (input.action === "prepare_launch" && input.launch_agent) {
            const sid = context?.sessionID ?? input.session_id
            if (sid) {
              launchBindings.set(sid, String(input.launch_agent), {
                execution_id: input.execution_id,
                dispatch_id: input.dispatch_id,
              })
            }
          }
          return json(result)
        },
      })

      editor.add({
        name: "harness_merge_candidate",
        description: "Merge the exact already-reviewed candidate's bound PR, per the governed_auto policy. The model provides only candidate_id; repository/PR/head/base/policy/CI/review are resolved from durable state. Credentials come from the HARNESS_GITHUB_TOKEN runtime environment variable, never from this input. Idempotent: a retry after a crash re-queries GitHub and records an existing merge instead of merging twice. Head/base drift, a closed-without-merge PR, or a merge with a different head fail closed.",
        input: objectInput({
          candidate_id: { type: "string", minLength: 1, description: "Content-addressed candidate id already recorded via record_candidate." },
        }, ["candidate_id"]),
        execute: async (input, context) => {
          const adapter = createGitHubAdapter({ token: process.env.HARNESS_GITHUB_TOKEN ?? "" })
          const result = await runMergeCandidate(requireProjectRoot(), {
            candidate_id: String(input.candidate_id ?? ""),
            adapter,
            session_id: context?.sessionID,
          })
          return json(result)
        },
      })

      editor.add({
        name: "harness_freeze_candidate",
        description: "Freeze a Work Unit's working-tree changes into a content-addressed candidate and store it in the candidate registry. Captures a base snapshot, overlay paths, deletions, and a frozen verification contract; returns the candidate_id. Never runs checks.",
        input: objectInput({
          wu_id: { type: "string", minLength: 1 },
          base_paths: { type: "array", items: { type: "string" }, maxItems: 2000 },
          overlay_paths: { type: "array", items: { type: "string" }, maxItems: 2000 },
          deletions: { type: "array", items: { type: "string" }, maxItems: 2000 },
          verification_contract: { type: "object" },
        }, ["wu_id"]),
        execute: async (input) => {
          const root = requireProjectRoot()
          const base = input.base_paths?.length ? await captureBaseSnapshot(root, input.base_paths) : null
          const contract = input.verification_contract ?? null
          if (contract && !contract.source_wu_id) contract.source_wu_id = input.wu_id
          const candidate = await freezeCandidate(root, {
            base,
            paths: input.overlay_paths ?? [],
            deletions: input.deletions ?? [],
            verification_contract: contract,
          })
          const stored = await candidateRegistry.store(candidate)
          return json({
            ...stored,
            candidate_id: candidate.candidate_id,
            display_id: candidate.display_id,
            manifest_hash: candidate.manifest_hash,
            tree_hash: candidate.tree_hash,
            verification_contract_hash: candidate.manifest.verification_contract?.contract_hash ?? null,
          })
        },
      })

      editor.add({
        name: "harness_run_verification",
        description: "Run one declared verification check against a frozen candidate. Loads the candidate from the registry, uses only its frozen verification contract (never a free-form command), materializes an isolated workspace, executes the check, and returns evidence bound to the candidate and contract. Undeclared checks and missing capabilities are blocked.",
        input: objectInput({
          candidate_id: { type: "string", minLength: 1, pattern: "^cand-[0-9a-f]{64}$" },
          verification_check_id: { type: "string", minLength: 1 },
        }, ["candidate_id", "verification_check_id"]),
        execute: async (input) => {
          const candidate = await candidateRegistry.load(input.candidate_id)
          if (!candidate) {
            return json({ status: "BLOCKED_UNKNOWN_CANDIDATE", candidate_id: input.candidate_id, reason: "no candidate with this id is in the registry." })
          }
          const result = await runCandidateVerification(candidate, input.verification_check_id)
          // Persist an immutable evidence receipt for checks that actually ran,
          // so a later RECORD_REVIEW can cite durable evidence rather than a
          // caller-declared "PASS".
          let evidence_id = null
          if (result.status === "PASS" || result.status === "FAIL") {
            const receipt = createVerificationReceipt(result)
            await writeVerificationReceipt(join(requireProjectRoot(), ".harness", "execution", "verification-results"), receipt)
            evidence_id = receipt.evidence_id
          }
          return json({ ...result, evidence_id })
        },
      })

      editor.add({
        name: "harness_check_execution_readiness",
        description: "Diagnostic preflight, never authority. Evaluates the concrete capabilities a Work Unit's frozen verification contract requires (builder/reviewer, verification runner, binaries, browser, network policy, budget) and returns READY or BLOCKED_CAPABILITY/BLOCKED_BUDGET with every requirement. Requirements are derived from the contract; the caller cannot invent capabilities. BUILD checks stable+volatile; REVIEW re-checks only volatile.",
        input: objectInput({
          wu_id: { type: "string", minLength: 1 },
          phase: { type: "string", enum: ["BUILD", "REVIEW"], default: "BUILD" },
          verification_contract: { type: "object" },
          candidate_id: { type: "string", pattern: "^cand-[0-9a-f]{64}$" },
          remaining_budget: { type: "number", minimum: 0 },
        }, ["wu_id"]),
        execute: async (input) => {
          let contract = input.verification_contract ?? null
          if (input.candidate_id) {
            const candidate = await candidateRegistry.load(input.candidate_id)
            if (!candidate) return json({ status: "BLOCKED", reason: `unknown candidate ${input.candidate_id}` })
            contract = candidate.verification_contract
          }
          if (!contract) {
            return json({ status: "BLOCKED", reason: "no verification contract available to derive requirements; pass verification_contract or candidate_id." })
          }

          let agents = new Set()
          let tools = new Set()
          try {
            const response = await ctx.agent.list()
            const records = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : Array.isArray(response?.agents) ? response.agents : []
            const ids = new Set()
            for (const agent of records) {
              for (const key of ["name", "id", "agentID", "identifier"]) {
                const value = agent?.[key]
                if (typeof value === "string" && value) ids.add(value)
              }
            }
            agents = ids
          } catch {}
          try {
            const response = await ctx.tool.list()
            const records = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : []
            tools = new Set(records.map((tool) => tool.id ?? tool.name).filter(Boolean))
          } catch {}

          const probe = async (capability, requirement) => {
            switch (capability) {
              case "contract.valid":
                try { validateVerificationContract(contract); return { status: "READY" } }
                catch (error) { return { status: "BLOCKED", reason: String(error?.message ?? error) } }
              case "builder.present":
                return agents.has("harness-builder") ? { status: "READY" } : { status: "BLOCKED", reason: "harness-builder is not available." }
              case "reviewer.present":
                return agents.has("harness-reviewer") ? { status: "READY" } : { status: "BLOCKED", reason: "harness-reviewer is not available." }
              case "verification.runner":
                return tools.has("harness_run_verification") ? { status: "READY" } : { status: "BLOCKED", reason: "harness_run_verification is not registered." }
              case "reviewer.execute_declared_checks":
                return (agents.has("harness-reviewer") && tools.has("harness_run_verification")) ? { status: "READY" } : { status: "BLOCKED", reason: "reviewer cannot execute declared checks." }
              case "workspace.supported":
                return { status: "READY" }
              case "network.isolation":
                return { status: "BLOCKED", reason: "network isolation is not yet enforceable." }
              default:
                if (capability.startsWith("binary.")) {
                  return resolveBinary(requirement.program) ? { status: "READY" } : { status: "BLOCKED", reason: `binary ${requirement.program} not found on PATH.` }
                }
                if (capability === "browser.headless") {
                  return detectBrowser() ? { status: "READY" } : { status: "BLOCKED", reason: "browser runtime unavailable." }
                }
                return { status: "BLOCKED", reason: `unknown capability: ${capability}` }
            }
          }

          const budget = { remaining: Number.isFinite(input.remaining_budget) ? input.remaining_budget : Number.POSITIVE_INFINITY }
          const info = {
            pluginRevision: null,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            pathDigest: pathDigest(process.env.PATH),
            binaries: Object.fromEntries((contract.commands ?? []).map((check) => [check.program, resolveBinary(check.program)])),
            browser: detectBrowser(),
          }
          return json(await checkExecutionReadiness({ contract, phase: input.phase ?? "BUILD", probe, budget, info }))
        },
      })
    })

    if (continuation.enabled) {
      ;(async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventSubscription.signal })) {
            await continuation.onEvent(event).catch(() => {})
          }
        } catch (error) {
          continuation.recordSubscriptionError(error?.message ?? String(error))
        }
      })().catch((error) => continuation.recordSubscriptionError(error?.message ?? String(error)))
    }

    await registerHarnessCommand(ctx)

    return () => {
      eventSubscription.abort()
    }
  },
})
