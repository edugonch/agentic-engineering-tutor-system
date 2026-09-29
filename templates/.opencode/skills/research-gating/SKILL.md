---
name: research-gating
description: Decide whether external or specialist research is justified and how to bound it; use when evidence is uncertain, current sources may be stale, an architecture or product decision is blocked, or a research agent is being considered.
compatibility: opencode
metadata:
  harness: research-control
---

# Research Gate

Research is an optional instrument for resolving a blocking decision, not a phase that automatically follows project intake or every WU.

## Admit research only when

- The unresolved question is written precisely.
- The decision that could change is named.
- Current approved sources have been checked and are insufficient.
- The answer is required before the next authorized decision or execution step.
- Sources, time/call budget, and a stop condition can be defined.

If any condition is false, continue with current authority, state uncertainty, or defer the question.

## Bound the assignment

Give the researcher one question, allowed source classes, the decision context, output format, and a stop condition. Keep the researcher read-only and prevent recursive delegation. Ask for primary sources, dates, conflicting evidence, limitations, and a confidence statement.

## Knowledge funnel

Keep four layers distinct:

1. **RAW** — retrieved output retained as received with provenance.
2. **Synthesis** — evidence comparison, conclusion, confidence, and limitations.
3. **Authority** — owner-approved decision or governance document.
4. **Execution context** — only the relevant approved facts supplied to an Epic/WU agent.

Do not let a RAW document, search snippet, or specialist recommendation silently become authority. Do not spawn research follow-ups. Return non-blocking questions to the owner as deferred context.
