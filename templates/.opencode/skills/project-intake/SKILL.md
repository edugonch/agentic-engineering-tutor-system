---
name: project-intake
description: Guide first-run discovery for a new software project; use when the owner describes a new idea, wants to define its goal or MVP, needs help framing constraints and success measures, or asks to initialize the Harness for a new project. For an existing repository use project-import.
compatibility: opencode
metadata:
  harness: project-discovery
---

# Project Intake

Use this skill to turn an informal software idea into a reviewable project charter and an explicit first decision. Do not start by asking for a complete specification. Gather only information that changes the story, MVP boundary, risk, or next safe action.

## Intake sequence

1. Reflect the problem and intended user in plain language. Mark uncertain details as assumptions.
2. Ask about the desired long-term outcome and why it matters.
3. Define the MVP as the smallest observable change that tests the project's main value. Name what is excluded.
4. Identify users/stakeholders, constraints, dependencies, privacy or safety concerns, and success evidence as relevant to the domain.
5. Identify uncertainties. Recommend research only when an exact answer could change the MVP/architecture or block the next authorized decision.
6. Summarize the project story, charter, assumptions, non-goals, success evidence, and open decisions.
7. Ask the owner to correct or approve that summary before calling the initialization tool.

## Question policy

- Ask one high-impact question at a time when the answer determines the next branch.
- Combine independent, low-effort questions in a short list; avoid repeating facts already supplied.
- Offer reasonable options when they reduce effort, while allowing a free-form answer.
- Continue with explicit assumptions only for reversible choices. Flag decisions about product scope, regulated behavior, sensitive data, external spending, and deployment for owner review.
- A vague idea is not a reason to ask every imaginable question. Start with problem, user, desired outcome, MVP, and success evidence.

## Research recommendation gate

Recommend research only when all are true: (a) a precise unresolved question exists, (b) it affects a named decision, (c) current authoritative project material cannot answer it, and (d) the answer is needed before the next safe step. Define the source scope and stop condition. Store retrieved outputs as raw evidence and synthesize separately. Do not create a research stream for non-blocking curiosities.

## Adaptive design discovery

- Let the user's goal and the next consequential decision determine the questions; do not run a fixed questionnaire when answers are already known.
- Ask who the stakeholders are, which constraints are real (technical, legal, operational, budget, privacy), and what observable evidence would demonstrate success.
- Surface quality attributes only when relevant. Turn a material quality need into a concrete scenario and ask for a measurable target if choosing one would change scope or obligations.
- Identify the largest decision-relevant uncertainty and its possible consequence. Recommend a small research task, prototype, or owner decision only if it can reduce that risk before the next step.
- Iterate: think about what must be learned, propose or make one useful artifact, check it with the owner or evidence, then choose the next step. Intake does not need to settle the entire future architecture.

## Output

Present a concise draft with: problem, user/context, destination, MVP/in-scope, non-goals, constraints, success evidence, assumptions, blocking question(s), and the owner decision requested. Do not create files until the owner approves.

## Grounding

Adapted from Michael Keeling, *Design It!* Chapters 2–5 and 14 (iterative design, risk-led strategy, stakeholders, constraints, quality attributes, and discovery). AI-specific evaluation and context practices are summarized in the plugin's `docs/knowledge-base/ai-engineering.md`.
