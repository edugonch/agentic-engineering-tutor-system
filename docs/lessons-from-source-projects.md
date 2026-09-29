# Lessons abstracted from Alfran and LLM Learning

This Harness is a separate, reusable OpenCode software-project plugin. Alfran and LLM Learning are source cases for its governance; neither project's domain, roadmap, or implementation is baked into the plugin.

## Observed difference

The owner reports that Alfran's work felt more fluent. Its governance treated the project as a story, Epics as chapters, and related Work Units as indivisible story beats that compose into each chapter. LLM Learning exposed a failure mode: its first Epic did not close, follow-up Work Units were created between existing Work Units, and the active Epic kept expanding for close to a month.

The design implication is to preserve a continuing project story while requiring each active Epic to have a finite user-visible ending and an owner-approved Work Unit ceiling. Work Units may have explicit sequence and dependencies, but cannot recursively create child, repair, coordination, research-follow-up, or successor units. If the approved boundary proves insufficient, stop and ask the owner to rebase or defer the remainder.

## Research and governance

Research in both projects was retained as raw material in project governance and then used to inform project decisions. The Harness keeps that useful evidence without turning every research lead into more work:

1. Keep retrieved material as RAW with source and retrieval date.
2. Synthesize what the evidence supports, conflicts, and leaves uncertain.
3. Let the owner approve a decision before it becomes project authority.
4. Give execution agents only the approved, decision-relevant context.

Research is admitted when one exact unresolved question blocks the next authorized decision or work unit. The assignment names its decision, sources, budget, and stop condition. A research result does not auto-create a follow-up task or expand an Epic.

## Human gates and future automation

The initial Harness keeps owner authority explicit and keeps merge, release, and deployment outside plugin automation. This supports trying bounded Work Units first and measuring the workflow before moving review to an Epic boundary. Any later Epic-level automation needs a separate release policy with verified per-WU evidence, isolated changes, recovery behavior, and an owner-controlled final gate.

## What must remain generic

- Discover project structure and existing authority instead of imposing a tracker or folder convention.
- Separate verified facts, owner intent, assumptions, raw research, synthesis, and approved decisions.
- Preserve existing files and history during import.
- Ask only project-specific questions that change the story, MVP, risks, or the next safe step.
- Do not hard-code either source project's Epic count, duration, budget, technology, or research subject.
