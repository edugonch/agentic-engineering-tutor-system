# Phase 4 — exact approved authority registration amendment

## Authority and boundary

Owner explicitly authorized only repair of the runtime-discovered registration
gap. The reviewed base implementation remains
`d385a84c5cae0e4fdd342ca856b7c434344c486d`. Packet v1 remains immutable at
`0a9db5c6227a0e2157bbc6790ac506b6510f79b0`; its registration was stopped before
writing any Epic, mandate or activation. No runtime examination is resumed.

This amendment adds exact-approved local registration; it changes no execution
controller operation, repair/blocker semantics, budget, dispatch, lineage,
agent profile, permission or Phase 5 behavior. The loaded plugin remains d385
until a separately authorized installation; source edits are not a runtime load.

## Implementation

- `src/project-knowledge.js`: exact mode is selected by either
  `content_source_path` or `expected_content_sha256`. Both are required together;
  model-provided `content` is rejected in this mode. Status must be APPROVED and
  owner confirmation literally true. The existing research-approval prohibition
  remains effective.
- The source must be a safe project-relative regular file. Absolute/traversal,
  ambiguous separators, symlinks (including parents), directories and missing
  sources fail closed. Descriptor opening uses NOFOLLOW/NONBLOCK and regular-file
  identity validation. Existing size limits apply before and after reading.
- The source is read once via the validated descriptor into a Buffer. Its exact
  SHA-256 must match before archive or index authority writes. That same Buffer
  is written with exclusive creation to the canonical artifact path, without
  trimEnd, generated frontmatter, title or string reconstruction.
- Approval metadata, source path, expected digest, title and relationships live
  in the knowledge index. Source revision and stored sha256 are the exact archive
  digest. Existing no-overwrite history and index locking are retained.
- `index.js`: exposes the optional source/hash pair. Legacy `content` remains
  validated by the existing core path when exact mode is not selected.
- `src/activation-gate.js`: exact file-backed APPROVED decisions conservatively
  require existing specialist readiness because their text is not in tool input.
  This prevents a new transport mode bypassing the existing activation guard,
  without rereading the source or altering profile/permission rules. Legacy
  non-exact activation detection and registration behavior are unchanged.

## Tests and evidence before independent review

`tests/exact-approved-registration.test.js` adds ten focused tests covering all
requested criteria: exact CRLF/trailing whitespace bytes; archive digest;
source_revision/index digest/byte count; findApprovedEpic mandate parsing;
wrong hash with no usable authority; unsafe path variants; final/parent symlink,
directory and missing source; required APPROVED and literal owner confirmation;
missing hash/path and conflicting content; immutable overwrite/failure behavior;
legacy envelope format; file-backed decision readiness.

Initial focused run: **1 PASS / 9 FAIL**, exposing the missing exact mode while
the legacy format check passed. Final focused run: **10/10 PASS**.
Complete suite: **275/275 PASS**, zero failures/skips.
Package validation: **73 paths PASS**. `git diff --check`: **PASS**.
No real authority artifact is registered by these tests: all writes use disposable
fixtures. Hash/read/write identity is implemented by retaining the one Buffer.

The candidate is frozen with four declared checks: `exact-registration`,
`regression`, `validate`, `entrypoint-syntax`. A fresh independent assessment is
required before committing. The earlier cand-e02d review does not apply here.
Post-freeze identity, receipts and review will be recorded separately in
`docs/phase-4-exact-registration-review-evidence.md`.

## Files in the amendment

```text
index.js
src/project-knowledge.js
src/activation-gate.js
tests/exact-approved-registration.test.js
docs/superpowers/plans/2026-10-01-exact-approved-registration.md
docs/phase-4-exact-registration-amendment.md
```

The later post-freeze review-evidence document is an additional reporting file.
After independent PASS, commit this amendment, then prepare/publish v2 as a
separate proposal. Only stale implementation/WU/document-path/provenance bindings
may change; v1 commands, capabilities, environment, envelope semantics and
normative verification hash must be preserved. Owner approval of v2 is required.

```text
PHASE_4_CONTRACT_GATE = PASS
PHASE_4_BOOTSTRAP_BASE_d385 = PASS
PHASE_4_IMPLEMENTATION = CHANGES_REQUIRED (pending independent review)
EPIC_RUNTIME_PACKET_V1 = BLOCKED_AUTHORITY
MANDATE = NOT_CREATED
WU = NOT_ACTIVATED
PHASE_4_RUNTIME_PROOF = BLOCKED_BEFORE_EXECUTION
PHASE_4 = UNVERIFIED
```
