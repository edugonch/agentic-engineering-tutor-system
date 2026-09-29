---
name: architecture-decision
description: Guide architecture discovery and consequential technical choices using project constraints, quality scenarios, risk, options, and verifiable evidence.
compatibility: opencode
metadata:
  harness: architecture-design
---

# Architecture Decision

Use this skill when a product or implementation choice could materially affect the MVP, system boundaries, quality attributes, cost, safety, or ability to change the system. Prefer the smallest design activity that can answer the decision. Do not produce a full architecture as a default intake artifact.

## Process

1. **Frame the decision.** State the question, who is affected, the relevant project-story/Epic outcome, current constraints, and what decision must be made now. Separate verified facts, assumptions, and owner preferences.
2. **Identify the risk.** Describe the uncertain condition and its plausible adverse consequence. Prioritize by likelihood and impact. If no consequential uncertainty or irreversible choice exists, make a reversible, conventional choice and record the assumption where useful.
3. **Make quality needs testable.** For relevant qualities (such as security, reliability, latency, accessibility, privacy, maintainability, or cost), define a concrete scenario and observable response. Do not invent universal thresholds; ask the owner when choosing one would change product scope or obligations.
4. **Explore a small set of viable options.** Respect existing constraints. Compare only options that could meet the need; identify trade-offs, consequences, unknowns, and reversibility. A prototype or bounded research task is justified only when its evidence can change the decision.
5. **Recommend and validate.** Give a recommendation tied to the outcome and evidence, state confidence and limitations, and define how the design will be checked (test, prototype, scenario walkthrough, or operational measure). Do not turn the recommendation into owner authority without approval when the choice is consequential.
6. **Record durable decisions.** For a consequential or difficult-to-reverse choice, draft an ADR with status, context, decision, alternatives, consequences, evidence, and revisit triggers. Keep raw research separate from synthesis and the approved ADR.

## Boundaries

- Keep architecture aligned with the continuing project story and the currently active finite Epic; defer adjacent design questions.
- Do not let an architecture discussion create recursive research, Epics, or child WUs. Return one exact blocker and the decision it prevents.
- Use only the minimum sufficient project context. Link to source documents rather than loading the entire repository or research archive.
- A design can be revised as evidence changes. Record why and what new evidence would justify revisiting it.

## Output

Return: decision question; relevant outcome and constraints; facts/assumptions; risk; quality scenarios; viable options and trade-offs; recommendation and confidence; validation evidence; approval needed; and ADR content or revisit trigger.

## Grounding

Adapted from Michael Keeling, *Design It!*: Chapters 3, 5–6, 11–12, 14, 16–17 (risk-led design, architecture-significant requirements, architecture choices, decision records, and evaluation). The exact project story/Epic/WU governance is a Harness rule informed by source-project evidence and owner direction, not a claim attributed to the book.
