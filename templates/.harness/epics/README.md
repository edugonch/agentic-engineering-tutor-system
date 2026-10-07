# Epic chapters

Each Epic is a finite chapter in the continuing project story. Its start boundary is the verified ending state of the preceding Epic when one exists; its end boundary is a terminal demo/acceptance plus a stable handoff toward the next Epic.

**The complete ordered WU sequence is declared at Epic start and frozen before the first WU is activated.** Every listed WU must already exist as a durable WU contract. Each WU is a self-contained outcome/story, while explicit predecessor/successor relationships provide continuity through the chapter.

A full-Epic execution mandate may automatically advance through that existing sequence. It may not create, append, insert, or derive successor WUs while executing.

No universal WU-count or time budget is assumed. If the approved WU sequence or budget is exhausted before the terminal condition is met, stop `EPIC_REBASE_REQUIRED`. Only an owner-approved rebase may replace the remaining finite plan. Do not add WUs automatically.

Use `../templates/EPIC.md` as the contract skeleton.
