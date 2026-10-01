# Exact approved authority registration — Implementation Plan

> Owner-directed amendment, executed inline in the primary session. Independent
> review is delegated only after freezing the implementation. No runtime WU.

**Goal:** Archive exact already-approved local bytes, without changing the
normal envelope path or any execution-controller semantics.

**Architecture:** Add mutually exclusive `content_source_path` and
`expected_content_sha256` inputs alongside legacy `content`. Validate APPROVED,
literal owner confirmation, safe path, regular non-symlink file and expected
digest before authority writes. Read one Buffer and exclusively write that same
Buffer. Keep metadata/provenance separately in the existing knowledge index.

**Tech Stack:** Node.js ESM, fs/promises, SHA-256, node:test.

## Ordered tasks

- [ ] Add `tests/exact-approved-registration.test.js`: exact trailing bytes,
  archive/index hashes and mandate parsing; hash/path/type/approval rejection;
  unchanged legacy envelope; immutable overwrite and failed-write authority;
  file-backed decision readiness guard. Run `node --test
  tests/exact-approved-registration.test.js` and retain RED evidence.
- [ ] Modify `src/project-knowledge.js`: one safe file-descriptor read into a
  Buffer, bounded by MAX_ARTIFACT_BYTES; compare expected hash before writes;
  preserve exclusive canonical archive creation and index locking. Exact mode
  bypasses envelope/title/trimEnd; legacy mode remains byte-compatible.
- [ ] Modify `index.js` to expose the optional source/hash pair; keep core
  validation authoritative. Modify `src/activation-gate.js` only to keep the
  existing specialist-readiness gate fail-closed for file-backed decisions,
  whose activation text is not available in the tool input.
- [ ] Run focused tests, `npm test`, `npm run validate`, `git diff --check`.
  Freeze all implementation files with declared focused/regression/validation
  checks and obtain a fresh read-only independent assessment of that candidate.
- [ ] After independent PASS, commit only amendment code/tests/documentation.
  Retain predecessor candidates and reviews. No installation or runtime action.
- [ ] Prepare a separate v2 proposal by preserving command/capability/environment
  bytes and all runtime semantics. Update only implementation/WU provenance
  bindings; recompute WU hash and require normative verification hash to remain
  `f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753`.
  Publish v2 for owner review; v1 approval never carries over to changed bytes.

No approved Epic registration, mandate, activation, controller operation changes,
profile/permission changes, or Phase 5 work is authorized by this plan.
