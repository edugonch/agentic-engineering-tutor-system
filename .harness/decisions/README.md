# Decision log

Record project decisions in separate dated entries. Include decision owner, status (proposed/approved/rejected/superseded), evidence, rationale, affected charter/Epic/WU contracts, and any revisit condition.

For consequential or difficult-to-reverse software architecture choices, start from `../templates/ADR.md`. An ADR records claim-level evidence and a verification plan; use `PROVISIONAL`, `EVIDENCE_SUPPORTED`, or `OWNER_DECISION_REQUIRED` to describe what has actually been checked. `EVIDENCE_SUPPORTED` is scoped to its cited claims/scenarios and is not owner approval. A proposed ADR becomes project authority only after its named decision owner approves it.

Architecture evidence can come from relevant repository paths/tests/measurements, bounded primary-source research, or an approved test/prototype/scenario walkthrough. For high-impact or hard-to-reverse choices, the orchestrator may request one independent, read-only challenge from `harness-reviewer`. Do not turn disagreement into repeated review calls; return it to the owner.

Research recommendations are proposals until the project owner approves them. When an authoritative source conflicts with another, surface both and ask the owner to resolve the conflict; do not silently select one.
