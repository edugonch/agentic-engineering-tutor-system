---
name: story-governance
description: Shape project narratives, finite Epic chapters, or roadmap sequencing; use when creating or revising a project story, proposing an Epic, deciding what belongs in a chapter, or checking that a roadmap has a meaningful end condition.
compatibility: opencode
metadata:
  harness: story-structure
---

# Story and Epic Governance

Keep one durable project story that explains the user's problem, destination, and sequence of meaningful changes. The full story may evolve indefinitely; never let that make an individual Epic open-ended.

## Story model

- Project: continuing narrative and destination; record meaningful changes without pretending every future chapter is known.
- Epic: one finite chapter with a start condition, one user-visible outcome, explicit exclusions, dependencies, bounded WU count, and terminal demo/acceptance.
- WU: an indivisible outcome inside one chapter. WUs can connect through order and dependencies but cannot create child units.

## Epic authoring

1. State why this chapter follows the current story.
2. Define its start condition from verified state.
3. Define the user-visible result and terminal demo/acceptance criteria.
4. Specify in/out of scope, dependencies, and an owner-approved maximum WU count. Do not assume a universal count.
5. Order WUs so their completed outcomes compose into the Epic result. Each WU must remain independently verifiable.
6. Define closure evidence and what becomes possible in the next chapter.

## Stop and rebase

When the chapter's WU budget is exhausted, do not append more WUs automatically. Return `EPIC_REBASE_REQUIRED`, summarize what is done and what is missing, and let the owner decide whether to reduce scope, approve a revised finite budget, or move remaining outcomes to a later chapter.

An unresolved non-blocking idea belongs in continuity notes or a proposed future chapter. It does not extend the active chapter.
