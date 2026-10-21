# Orphan dispatch recovery — proposed maintenance Epic

Status: PROPOSED / NOT CONTROLLER-ACTIVATED
Owner mandate: 2026-10-20 (prospective; historical Harness v1 Phase 4 FAIL unchanged)
Epic: HMR-ODR-2026-10
Single WU: HMR-ODR-01
Ceiling: 14,400 seconds total, no automatic extension
Source Epic SHA-256: 1cc5ec3f56d100713da0a81bfac76bc4dfb6cfe6d447de19229f16680b3d1c6e
Source WU SHA-256: 9c9dc1dc49b6430e85b042adce956de86abfbeb6f3d5ec41af2c34dc1edbf574

Only one maintenance WU is permitted. Do not activate or claim
APPROVED without exact source provenance in the local Harness knowledge index
and its append-only controller. This branch is an implementation work in progress,
not execution evidence, and cannot be merged until an independent reviewer,
node20/22/24, packaged-plugin CI and live runtime fencing all pass.

Required outcome: safely fence a genuinely interrupted launched child,
durably classify abandonment separately from success, conservatively settle
its reservation exactly once, and resume the same ALFRAN E05-07-E WU while
preserving both untracked partial files.

No historic Phase 4 modification, fake record_finish, journal edits, duplicate
builders, authority bypass or unsafe release.
