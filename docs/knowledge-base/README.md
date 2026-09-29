# Engineering knowledge base

This directory records concise, reusable principles that inform the Harness. It is a source map and application guide, not a copy of the books. Keep the distinction clear:

- **Project evidence** is what we observed in Alfran and LLM Learning, preserved in [lessons-from-source-projects.md](../lessons-from-source-projects.md) and source-project research records.
- **Engineering theory** is summarized from the two books below. It informs the design of the Harness, but does not prove that a rule worked in either source project.
- **Owner-approved governance** remains the authority for any project using the Harness.

## Sources and where to apply them

| Source | Primary use in this Harness | Main implementation locations |
|---|---|---|
| Chip Huyen, *AI Engineering* | Design the Harness as an AI system: context construction, agent/tool failure modes, evaluation, observability, and staged complexity. | Orchestrator and agent profiles; research gate; bounded context handoffs; plugin validation and behavior evaluation. |
| Michael Keeling, *Design It!: From Programmer to Software Architect* | Guide the orchestrator's software design work: problem discovery, stakeholder needs, risk-led design, quality attributes, architecture choices, decision records, and evaluation. | Project intake; architecture-decision skill; project story/Epic/WU contracts; ADRs and scenario walkthroughs. |

The books are inputs to our reasoning. This repository contains only brief paraphrases, source locators, and our application of those ideas; it does not redistribute either book.

## Use by task

- Starting a new project: `project-intake` and `project-story` draw on *Design It!* problem discovery, stakeholders, constraints, and success measures.
- Importing a project: `project-import` uses a bounded, progressive context review. Repository inventory is a map, not a reason to load every file into a prompt.
- Choosing architecture: `architecture-decision` applies risk-first exploration, quality scenarios, trade-offs, and explicit evaluation.
- Planning delivery: `story-governance` makes the project a continuing story, each Epic a finite chapter, and each WU one independently verifiable outcome. This structure is a Harness rule informed by project evidence; the book's “tell the whole story” architecture guidance is supporting design theory, not the origin of the chapter rule.
- Delegating and executing: AI-system concerns from *AI Engineering* shape narrow agent responsibilities, minimum sufficient context, observable handoffs, and explicit stopping/evaluation.
- Research: keep raw evidence, synthesis, owner authority, and execution context as separate layers; admit research only when a bounded answer can change a named decision.

## Updating this knowledge base

When adding a principle, include its source locator, the decision or behavior it informs, and whether it is **book-derived theory**, **project evidence**, or an **owner decision**. Do not elevate a book recommendation into universal project policy without considering the current project's domain, constraints, risk, and owner preferences.
