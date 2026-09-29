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

1. **Inventory (read-only).** Call `harness_analyze_existing_project`. Use its markers and candidate paths to choose a small, relevant set of files to inspect. Do not dump the whole repository into context. Excluded or unlisted files may still matter; follow up only where the current decision depends on them.
2. **Establish authority.** Identify which project documents are current, who owns them, their dates/versions, and where plans conflict with implementation. Keep raw research separate from synthesis and owner-approved decisions. Code may show what exists; it does not by itself prove what the owner intends.
3. **Reconstruct the continuing story.** Summarize the original problem, users, meaningful delivered outcomes, current destination, and likely next chapter. Label verified facts, owner statements, and assumptions separately. Preserve important milestones and decision rationale.
4. **Map the current roadmap.** Propose mappings for existing Epics, Work Units, research, decisions, and project state. Distinguish completed, active, planned, blocked, stale, and uncertain items. Map an existing issue as one WU only if it has one independently verifiable outcome; do not split it into nested tasks to satisfy a template.
5. **Bound the active chapter.** If an Epic is open-ended, has recursively expanding WUs, or lacks a terminal outcome, do not import that shape as-is. Present what is complete, what remains, and a finite rebase proposal. Owner approval determines whether the existing chapter is closed/rebased or retained as historical context.
6. **Approve before writing.** Present the proposed story, charter, authority sources, migration mapping, open questions, non-goals, and any decisions needed. Do not scaffold, move, rename, rewrite, or delete project files during assessment. After the owner approves the summary and explicitly authorizes initialization, call `harness_initialize_project` with `project_type: "existing"` and the approved mapping in `import_assessment`; it records that assessment in `.harness/IMPORT_ASSESSMENT.md`, creates only missing Harness files, and leaves every existing path untouched.

## Mapping rules

- Keep the repository's existing work tracker and governance locations as the source of record unless the owner chooses a new one.
- Add references or a concise index rather than copying all legacy content into context or duplicating it into a second authority.
- Preserve raw research exactly where possible, with provenance and retrieval date. Synthesis records what the evidence supports, limitations, and how it affected a project decision.
- A project may continue indefinitely; each imported active Epic must have a finite start, one user-visible outcome, bounded owner-approved WU count, explicit exclusions, and an ending/demo.
- A WU is one indivisible outcome with independent acceptance evidence. WUs can be related by sequence and dependencies; they never create child WUs.
- Do not assume Alfran or LLM Learning's domain, work-tracker conventions, governance format, or budget values generalize. Abstract principles and ask only about project-specific decisions that affect the mapping.

## Output

Return a concise import assessment with: current-story summary; verified project state; authority and source conflicts; proposed story/Epic/WU mapping; research and decisions to preserve; items not to import; assumptions; blocking questions; and the exact owner decision required before scaffolding. Give paths as evidence. Do not claim migration is complete until files are reviewed against the approved mapping.
