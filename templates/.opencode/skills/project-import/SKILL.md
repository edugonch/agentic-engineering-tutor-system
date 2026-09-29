---
name: project-import
description: Bring an existing software repository under Harness governance; use when the owner wants to assess, migrate, or preserve an existing project's story, roadmap, research, decisions, Epics, or Work Units.
compatibility: opencode
metadata:
  harness: existing-project-import
---

# Existing Project Import

Treat import as a controlled understanding and mapping process, not a repository rewrite. The goal is to add reusable governance around a working project while preserving its code, decision history, current status, and useful evidence.

## Stages

1. **Inventory (read-only).** Call `harness_analyze_existing_project`. Use `knowledge_archive.documents` to enumerate the complete discovered source set, including research, research compendia/syntheses, governance/rules, decisions, requirements/specifications, state, Epics, stories, and WUs. Read every discovered item in those classes in bounded batches; do not select only a few representative examples or dump them all into one model context. The inventory is bounded; report truncation and do not claim a complete import if limits were reached.
2. **Establish authority.** Identify each source's exact path/ID, version or revision, owner, date, status, and authority; reconcile documents with implementation and note conflicts. For Google Drive, use the project's configured One CLI/MCP route and exact IDs/revisions. Never use a browser or title-only search as evidence. Keep raw research separate from compendia/synthesis and owner-approved decisions. Code may show what exists; it does not by itself prove what the owner intends.
3. **Reconstruct the continuing story.** Summarize the original problem, users, meaningful delivered outcomes, current destination, and likely next chapter. Label verified facts, owner statements, and assumptions separately. Preserve important milestones and decision rationale.
4. **Map the current roadmap.** Propose mappings for existing Epics, Work Units, research, decisions, and project state. Distinguish completed, active, planned, blocked, stale, and uncertain items. Map an existing issue as one WU only if it has one independently verifiable outcome; do not split it into nested tasks to satisfy a template.
5. **Bound the active chapter.** If an Epic is open-ended, has recursively expanding WUs, or lacks a terminal outcome, do not import that shape as-is. Present what is complete, what remains, and a finite rebase proposal. Owner approval determines whether the existing chapter is closed/rebased or retained as historical context.
6. **Approve before writing.** Present the proposed story, charter, full source inventory, authority references, migration mapping, open questions, non-goals, and any decisions needed. Do not scaffold, move, rename, rewrite, or delete project files during assessment. After explicit owner approval of the import mapping, call `harness_import_project_knowledge` to snapshot all relevant local documents and external records in bounded batches. External Drive inputs must include the exact Drive ID, exact version/revision, retrieval time, classification, declared authority, and retrieved text from the configured One route. Review its hashes, conflicts, and index; a snapshot is `SNAPSHOT_UNVERIFIED` until compared with the live source. Only after this archive step, initialize with `harness_initialize_project`, passing the exact `project_story_ref` and `project_state_ref` where those authorities already exist. The scaffold writes pointer files and does not create duplicate story/state authorities. Do not claim the migration is complete until the index and every imported source have been checked.

## Mapping rules

- Keep the repository's existing work tracker and governance locations as the source of record unless the owner chooses a new one.
- Add references or a concise index rather than copying all legacy content into context or duplicating it into a second authority.
- Preserve raw research byte-for-byte where possible, with exact source ID/path, revision, retrieval date, checksum, and relationships. Preserve a new revision alongside the old; never overwrite research history. Synthesis records what the evidence supports, conflicts, limitations, and how it affected an owner decision.
- Before re-collecting research, search the archive, read the exact source revision, and check the live source for freshness. Reuse valid prior research; append only if a named decision needs missing or updated evidence.
- Extract requirements/specifications and user stories as separate derived artifacts. Each carries exact source record keys/revisions and decision parents. An approved user story must parent to an indexed owner-approved requirement/specification; raw research cannot be promoted directly.
- A project may continue indefinitely; each imported active Epic must have a finite start, one user-visible outcome, bounded owner-approved WU count, explicit exclusions, and an ending/demo.
- A WU is one indivisible outcome with independent acceptance evidence. WUs can be related by sequence and dependencies; they never create child WUs.
- Do not assume Alfran or LLM Learning's domain, work-tracker conventions, governance format, or budget values generalize. Abstract principles and ask only about project-specific decisions that affect the mapping.

## Output

Return a concise import assessment with: current-story summary; verified project state; authority and source conflicts; proposed story/Epic/WU mapping; research and decisions to preserve; items not to import; assumptions; blocking questions; and the exact owner decision required before scaffolding. Give paths as evidence. Do not claim migration is complete until files are reviewed against the approved mapping.
