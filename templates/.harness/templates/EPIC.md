# E[NN] — [Chapter title]

Status: DRAFT  
Project story link: `.harness/PROJECT_STORY.md`  
Product Owner approval: [PENDING]

## Chapter purpose

What changes for the user at the end of this chapter, and why is this the next chapter in the project story?

## Story boundaries

- Previous Epic / starting boundary: [PREVIOUS EPIC ID OR NONE]
- Verified starting state: [EXACT ACCEPTED STATE THIS EPIC INHERITS]
- Next Epic / handoff boundary: [NEXT EPIC ID OR UNKNOWN]
- Required handoff at closure: [STATE THIS EPIC MUST LEAVE FOR THE NEXT CHAPTER]

## Start condition

State the verified condition that must be true before the chapter starts.

## User-visible outcome

Describe one cohesive user-facing result. Keep implementation detail secondary to the outcome.

## Terminal demo and acceptance

- Demo scenario: [USER-VISIBLE SCENARIO]
- Acceptance evidence: [OBSERVABLE RESULT OR TEST EVIDENCE]
- End condition: [EXPLICIT CONDITION THAT CLOSES THIS CHAPTER]

## Approved WU budget

- Maximum WU count: [POSITIVE OWNER-APPROVED INTEGER]
- Budget approval status: [PENDING]
- Approval reference: [APPROVED DECISION ID / DATE]
- If exhausted before the terminal condition: stop with `EPIC_REBASE_REQUIRED`; no automatic extension.
- The maximum is a ceiling, not permission to create unnamed WUs after activation.

## Execution mandate envelope

Before approval, encode the same finite sequence in the machine-readable mandate. Every `wu_sequence` entry must correspond to a WU contract already created and linked to this Epic before the mandate is approved.

`execution_mandate: {"max_wus": 3, "total_seconds": 10800, "merge_policy": "none", "required_ci_checks": [], "wu_sequence": ["WU-001", "WU-002", "WU-003"]}`

Replace the example values with this Epic's owner-approved budget/policy/sequence. The sequence order is binding during execution.

## Work Unit sequence

This complete finite sequence is frozen before the first WU is activated. Every listed WU must already exist as a durable WU contract. Execution may advance through this list; it may not append successor WUs. If this sequence proves insufficient, stop `EPIC_REBASE_REQUIRED`.

| Order | WU | Outcome | Depends on | Hands off to | Status |
|---:|---|---|---|---|---|
| 1 | [WU ID] | [one self-contained outcome] | [none or WU ID] | [next WU ID or EPIC CLOSE] | DRAFT |

- Terminal WU: [WU ID ALREADY LISTED ABOVE]

## Out of scope

- [Explicit exclusions; move later work to a proposed later chapter, not a child WU]

## Dependencies

- Product, research, technical, or external prerequisites that genuinely block this chapter.
- A dependency does not authorize a new WU unless it is included within this approved budget or the owner approves a rebase.

## Exit record

- Terminal demo evidence: [PENDING]
- Review result: [PENDING]
- Owner chapter review: [PENDING]
- Merge/release decision: [PENDING]
- Story continuity update: [PENDING]
