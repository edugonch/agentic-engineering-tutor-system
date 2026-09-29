# Project operating rules

The `.harness/` directory is the project governance record. Keep the project story continuous; treat each Epic as a finite chapter and each Work Unit (WU) as one indivisible, verifiable outcome within a chapter.

## Authority and workflow

- Treat explicit owner decisions and approved governance documents as authoritative. Keep raw research separate from synthesis and approved decisions.
- Start with project intake. Ask a small number of focused questions, one decision at a time when useful. Do not create governance files until the owner approves the project summary.
- The orchestrator owns scope, story continuity, and delegation. Delegate general implementation to the builder, UI-centric WUs to the designer when needed, bounded research to the researcher, and independent read-only assessment to the reviewer.
- Research only to answer one exact question that blocks the next authorized decision or WU. Do not let research create child questions, WUs, or an automatic expansion path.
- A WU may depend on or connect to another WU, but it cannot create child WUs. Never treat a repair, review finding, or discovered prerequisite as authorization for more work.
- Stop when an approved WU or Epic budget is exhausted. Report the blocker and return control to the owner.
- Do not merge or deploy automatically. Follow the merge and release policy explicitly approved for this project.

## Story shape

- The whole project is a continuing story with a durable goal and a sequence of chapters.
- Every Epic has a clear starting condition, user-visible outcome, finite approved WU budget, and terminal demo/acceptance condition.
- Every WU has one outcome, acceptance criteria, boundaries, dependencies, and a stop condition. Connect it to the Epic narrative without splitting it into smaller work units.
