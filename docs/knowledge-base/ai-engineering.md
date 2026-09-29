# *AI Engineering* — Harness application notes

**Source:** Chip Huyen, *AI Engineering: Building Applications with Foundation Models*. Section references below use chapter/section titles so they remain useful across print and electronic pagination. These notes are paraphrases and application guidance, not a replacement for the source.

## Principles relevant to this plugin

### Start with the product behavior, then add system complexity

The book frames AI engineering around building a useful AI application and making explicit trade-offs, rather than choosing a model or architecture in isolation. Start the Harness with the smallest reliable workflow. Add agents, tools, retrieval, guardrails, routing, or other components when a demonstrated need justifies them.

**Harness application:** keep one primary orchestrator and a small number of role-bounded agents. Do not add agent layers or tool calls merely because the platform supports them. A new role needs a distinct responsibility, permitted capability, bounded assignment, and verifiable handoff.

### Treat context construction as a first-class design decision

The context-construction chapter covers retrieval and agentic approaches as ways to assemble the information needed for a task. More context is not automatically better: relevance, authority, freshness, and organization affect whether the model can use it.

**Harness application:** give an agent the active contract, the minimum relevant project-story/decision excerpts, relevant code or evidence, and explicit boundaries. Keep source documents in governance and retrieve them by task. Do not paste an entire repository or research archive into every agent call. Mark each fact's source and authority.

### Evaluate the whole system and name agent failure modes

The evaluation chapters distinguish model behavior from application behavior. Agent failures include poor planning, incorrect tool selection or arguments, incomplete execution, and inefficiency. Evaluation should reflect the task's desired outcome and should be used throughout development.

**Harness application:** evaluate whether the workflow preserves authorization, chooses the correct specialist, respects scope/budgets, reaches acceptance evidence, stops on blockers, and avoids recursive work. Track failures by stage (intake, research, planning, execution, review, closure), not just whether a final answer sounds plausible. Use representative new-project and existing-project scenarios before changing orchestration rules.

### Make cost and observability explicit without pretending step limits are dollar limits

AI application architecture includes operational concerns such as monitoring and inference efficiency; agent tool use and repeated attempts contribute to cost and latency.

**Harness application:** bound steps, delegation depth, retries, and repeated calls; detect no progress; stop after a repeated failure unless new evidence changes the hypothesis. Report usage when the platform exposes it. A step/call cap is a loop guard, not an exact monetary ceiling.

## Relevant source map

- Chapter 3, **Evaluation Methodology**: evaluation targets and system behavior.
- Chapter 4, **Evaluation Pipeline**: constructing and using an evaluation process.
- Chapter 5, **Prompt Engineering**: instructions and task framing.
- Chapter 6, **Context Construction**: retrieval and agentic context assembly.
- Chapter 10, **AI Engineering Architecture** and user feedback: evolving system architecture and operational feedback.

Use these chapters when revising the Harness's evaluation, agent prompts, context handoffs, or orchestration architecture. Prefer a small, measurable change over a speculative architecture expansion.
