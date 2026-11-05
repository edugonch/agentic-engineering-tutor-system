# Work Unit batch delivery

The Harness can optionally consolidate two through ten consecutive frozen Work Units
into one delivery cycle. Existing single-WU behavior remains unchanged.

Use the controller action `configure_wu_batch` **before the lead WU starts work**.
Specify the exact ordered `wu_ids`, freshly observed `expected_revision`,
and the owner's explicit instruction reference. The controller checks that the
WUs already exist in the approved Epic, that no lead candidate or dispatch
has started, and that each member's source includes scope and acceptance
criteria. An invalid request fails without changing the journal.

A configured batch freezes member source hashes and content. Supply these
requirements to the builder and reviewer. One candidate and one full verification
cycle can cover the complete batch. The independent reviewer must assess each
member individually and record all ordered WU IDs through
`batch_coverage_wu_ids` when recording PASS.

Existing CI, exact-head PR, merge policy and review constraints still apply.
After one verified merge, the ordinary `complete_wu` action records a
completion receipt for every batch member with the same candidate and merge SHA.
It advances the frozen WU sequence only after all acceptance gates pass.

Do not group a WU that is already underway, invent new WUs, or change the Epic
budget and authority. If the owner authorizes a recurring grouping policy,
subsequent batches can cite that same instruction; otherwise each group requires
an explicit owner instruction.
