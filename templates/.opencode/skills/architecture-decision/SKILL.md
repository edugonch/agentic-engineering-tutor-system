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
3. **Classify what is uncertain.** Do not treat every architecture doubt as a research question.
   - **Current project fact:** inspect the authoritative decision, relevant code, tests, configuration, or telemetry. Cite exact paths and distinguish what the repository does from what the owner intends.
   - **External/platform fact:** if current project evidence cannot answer it, delegate one exact, decision-blocking question to `harness-researcher`, preferably against primary/official sources. Keep it read-only and bounded; follow up only with a new concrete hypothesis within the existing assignment.
   - **Design trade-off:** compare viable options against constraints and quality scenarios. More searching does not prove which trade-off the owner prefers.
   - **Empirical behavior:** define a small scenario walkthrough, test, measurement, or prototype that can distinguish options. A reversible test or experiment may run inside an already-authorized WU when its scope covers the question; record evidence and revert disposable changes. Outside that scope, obtain the required owner decision without creating a WU automatically.
   - **Product/policy preference:** present the consequence and ask the owner. Neither research nor agent consensus can decide it.
4. **Make quality needs testable.** For relevant qualities (such as security, reliability, latency, accessibility, privacy, maintainability, or cost), define a stimulus, context, expected response, and observable threshold. Do not invent universal thresholds; ask the owner when the target changes scope or obligations.
5. **Explore a small set of viable options.** Respect existing constraints. Compare only options that could meet the need; identify trade-offs, consequences, unknowns, and reversibility. Choose the smallest design activity that can reduce the highest consequential risk.
6. **Plan and assess verification.** For each important claim, state what evidence would support or falsify it and the stop condition. Evidence may be repository behavior, a primary source, a test/prototype, an operational measurement, or a scenario walkthrough. A second LLM agreeing is not verification. Mark the result `EVIDENCE_SUPPORTED`, `PROVISIONAL`, or `OWNER_DECISION_REQUIRED`, with limitations; do not claim an architecture is universally proven.
7. **Request an independent challenge when warranted.** For a high-impact, security/safety-relevant, difficult-to-reverse, or materially disputed choice, ask the existing `harness-reviewer` to critique the exact decision record read-only. Supply the constraints, quality scenarios, evidence, and options. Ask it to find counterexamples, unsupported assumptions, omitted viable alternatives, and failed acceptance scenarios. One challenge only per unchanged proposal; technical findings can be investigated and repaired in the existing WU, followed by fresh review of changed evidence. Escalate an actual owner trade-off, not disagreement alone. Low-risk reversible choices do not need another agent.
8. **Record durable decisions.** For a consequential or difficult-to-reverse choice, draft `.harness/templates/ADR.md` into `.harness/decisions/` with status, evidence, verification plan/results, reviewer challenge if used, consequences, owner approval, and revisit trigger. Keep raw research separate from synthesis and the owner-approved ADR. A proposed ADR is not authority.

## Verification decision table

| Doubt | How to check | Stop and report when |
|---|---|---|
| What does the current code/system do? | Read the relevant implementation, tests, config, or bounded runtime evidence; cite the path/result. | Evidence conflicts or does not cover the needed scenario. |
| What does a platform/library support? | One bounded researcher assignment using current primary documentation; record URL/date and the exact claim supported. | The claim is answered, budget ends, or credible sources disagree. |
| Which architecture option fits better? | Compare options against owner constraints and concrete quality scenarios; use a small discriminating prototype/test only if needed. | Evidence supports a provisional choice, or the remaining trade-off is for the owner. |
| Is a consequential proposal robust? | One independent, read-only reviewer challenge against the decision record and stated scenarios. | Reviewer returns a challenge, blocker, or bounded support; do not auto-loop. |

## Boundaries

- Keep architecture aligned with the continuing project story and the currently active finite Epic; defer adjacent design questions.
- Do not let an architecture discussion create recursive research, Epics, or child WUs. Return one exact blocker and the decision it prevents.
- Use only the minimum sufficient project context. Link to source documents rather than loading the entire repository or research archive.
- A design can be revised as evidence changes. Record why and what new evidence would justify revisiting it.
- Use `EVIDENCE_SUPPORTED` only for the specific claim and scenarios directly covered; it is not the same as owner approval. If a needed claim remains provisional, say so and do not base irreversible work on it.
- Never “verify” a design by asking agents to agree with one another. The reviewer challenges the reasoning; evidence and the owner decide what follows.

## Output

Return: decision question and uncertainty class; relevant outcome and constraints; facts/assumptions with source paths; risk; quality scenarios; viable options and trade-offs; recommendation and confidence; claim-level verification plan/results and limitations; status (`EVIDENCE_SUPPORTED`, `PROVISIONAL`, or `OWNER_DECISION_REQUIRED`); independent challenge when warranted; owner approval needed; and ADR content or revisit trigger.

## Grounding

Adapted from Michael Keeling, *Design It!*: Chapters 3, 5–6, 11–12, 14, 16–17 (risk-led design, architecture-significant requirements, architecture choices, decision records, and evaluation). The exact project story/Epic/WU governance is a Harness rule informed by source-project evidence and owner direction, not a claim attributed to the book.
