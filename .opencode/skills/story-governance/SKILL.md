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

## Check that the chapter is a story

- The project story explains the durable user problem and how delivered chapters move toward the destination. Update it when evidence or owner decisions change that narrative.
- An Epic is a chapter: its opening state makes sense from the prior story, its WUs build connected outcomes, and its ending can be demonstrated to the user or stakeholder.
- A WU is an indivisible story beat with a separately verifiable outcome. Relate units through explicit sequence and dependencies; do not confuse connectedness with permission to split one outcome into nested units.
- Use the terminal demo as an evaluation scenario: walk through how the user experiences the promised result and what evidence proves it. Close the chapter against that evidence.
- State the maximum approved WU budget before activation. If new risk or scope appears, stop and present a finite rebase decision; do not expand the chapter in the name of narrative completeness.

## Grounding

The continuing-story / finite-chapter / indivisible-WU rule is a Harness governance choice based on Alfran and LLM Learning evidence plus owner direction. Michael Keeling, *Design It!* Chapter 11 (“Tell the Whole Story”) and Chapter 17 (scenario walkthroughs) inform how to explain and evaluate architecture and outcomes, but do not establish this specific Epic/WU model. Use risk-led planning from Chapters 3 and 14 to decide how much design or research a chapter needs.
