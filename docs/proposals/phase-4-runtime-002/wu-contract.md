# Proposed WU: resolveBinary supports absolute executable paths

Status: **PROPOSED / NOT APPROVED / NOT ACTIVE**. This is a draft contract for
owner review, not an activated Work Unit or an authorization to execute.

- Proposed Epic: `EPIC-P4-RESOLVEBINARY-ABSOLUTE-002`.
- Sole derived WU: `WU-P4-RESOLVEBINARY-ABSOLUTE-002`.
- Contract revision: `proposal-v3`.
- Bootstrap source baseline: `384bd085fa31085456ac1f2552ad922d2f43e74a`.
- Frozen Phase 4 design: `docs/phase-4-bounded-repair-and-blocker-resolution.md`,
  SHA-256 `82de3f16a69853871e567c592fe30b56f0c80706ef189b8f77682d7c1c794bda`.

## One indivisible outcome

The readiness resolver recognizes absolute executable regular files directly,
independently of PATH, while retaining the accepted simple-name PATH semantics.
Demonstrate one bounded A-to-B correction of this outcome under the same WU,
Epic, mandate, scope and cumulative budget. There are no child, repair,
successor, replacement or coordination WUs.

## Exact changed-path scope

1. `src/resolve-binary.js`.
2. `tests/resolvebinary-executable.test.js` — extend this existing focused file;
   preserve its accepted executable-bit regression. No second test file.

All other source/configuration/profile/permission files remain unchanged. A
candidate contains the two scoped files plus unchanged baseline `package.json`
for ESM materialization. Its base identity is bound in the Epic envelope. Compare
composed trees, including deletion/mode changes; an overlay path list is not
authority to replace the base. Test scratch resources below are not candidate
changes or an expansion of repository implementation scope.

## Acceptance behavior, identical for A and B

1. An absolute executable regular file resolves to its absolute path with empty
   PATH and with an unrelated PATH.
2. A nonexistent absolute path returns null.
3. An absolute directory path returns null, even when its mode has execute bits.
4. An absolute non-executable regular file returns null.
5. Simple-name PATH search continues to find executable regular files.
6. Simple-name non-executable files, directories and missing files remain rejected.

## Immutable verification contract

Reference: `docs/proposals/phase-4-runtime-002/verification-contract.json`.
Normative hash, as computed by `verificationContractHash`:
`f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753`.

The normative identity binds exact command IDs/programs/argv, capabilities and
environment. Source-WU provenance separately binds this document's bytes/hash;
it is not circular input to the normative hash.

- `resolver-acceptance`: `node --input-type=module -e <frozen script>` runs all six
  behavior groups with local temporary files. It includes the directory assertion
  from the outset, independently of builder-editable tests.
- `resolver-regression`: `node --test tests/resolvebinary-executable.test.js`.
- `tooling-ready`: a frozen Node diagnostic reads the exact external local fixture
  path below and requires regular-file content `READY` followed by a newline.

Every reviewer executes **all three** checks through candidate verification and
decides independently. All verification time is inside the corresponding positive
review/recovery reservation. No check substitution, weakening, skipping to obtain
PASS, new commands, or contract/hash changes during repair. Missing capabilities
or a required undeclared check return to the owner.

The checks use bare program `node`, which the existing readiness resolver can
find without relying on the absolute-path feature being demonstrated. Preflight
must confirm its runtime version and binary. The runner's honest network policy
is UNRESTRICTED because NETWORK_FORBIDDEN is not enforceable by this runner;
these commands perform no network access and authorize no new network operations.

## Explicit deliberate repair injection — effective only upon Epic approval

The owner-approved version of this Epic would explicitly authorize builder A
to intentionally leave **only the absolute-directory rejection** unresolved.
Keep the complete acceptance contract and directory test visible throughout;
do not remove or skip assertions or modify expected results. Preserve the other
five behaviors and the accepted simple-name executable-bit behavior.

The reviewer is never instructed to return CHANGES_REQUIRED. It executes the
complete frozen checks against A and records its actual independent verdict and
findings. Unexpected PASS(A) is reported honestly and does not establish bounded
repair. A BLOCKED verdict is not relabeled. Only a real actionable
CHANGES_REQUIRED review can authorize the single repair.

Builder B receives the exact recorded findings and their hash, and fixes the
directory issue in this same WU. B must have a changed composed tree, unchanged
scope, WU provenance and verification contract. A's candidate/review remain
immutable. Fresh B receipts and a fresh reviewer distinct from builder A, repair
builder and reviewer A are mandatory before WU_COMPLETE.

## One finite budget

Total cumulative ceiling: **1800 seconds**; `max_wus = 1`;
`max_repair_cycles = 1` consumed durably at authorization, not refunded by
restarts, releases, changed IDs or session changes.

| Authorized dispatch | Reservation |
|---|---:|
| Build A, including isolated fixture setup | 300 seconds |
| Verification and independent review A | 300 seconds |
| Repair B, if actually authorized by review | 300 seconds |
| Fresh verification and independent review B | 300 seconds |
| Exact tooling recovery and its success diagnostic | 120 seconds |
| Unallocated headroom, not a separate execution entitlement | 480 seconds |

The original ceiling never resets or increases. Conservative settlement consumes
the full reservation when measured consumption is unavailable. Funding must
leave room for the required next verification/review. One semantic slot permits
one dispatch. An ambiguous external launch retains its reservation and is not
relaunched. Audit/reconciliation does not create a new execution entitlement.

## Bounded tooling fixture and recovery

Exact isolated resource:
`/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system/.harness/execution/runtime-fixtures/phase4-resolvebinary-absolute-v1/ready.txt`.

The fixture directory must be absent at runtime preflight. If already present,
stop for owner review rather than overwrite or delete unknown work. Under Build
A's reservation, create only that private parent directory, leaving `ready.txt`
absent as the explicitly proposed tooling injection. Do not remove unrelated
resources or alter permissions. Fixture setup is charged build work, not a new WU.

After settled Build A and recording candidate A, record BLOCKED_TOOLING with the
observed missing-resource evidence. Before reviewer A begins, authorize exactly
one approved `restore-ready` action, with actor `harness-builder`, tool `shell`
and the precise input in the Epic envelope. That action writes `READY\n` to the
absent file using exclusive creation. It does not run the resolver or edit code.
Its single-use durable claim precedes the side effect. It shares the 120-second
reservation with `tooling-ready` verification bound to candidate A.

Resolution requires observed action success, the real PASS diagnostic receipt,
and settled dispatch. Failure, missing outcome or ambiguity never permits a
repeat. The same attempt survives restart; a new blocker/dispatch/operation/
execution/session identity cannot replenish it. Preserve the isolated fixture
as evidence until an owner separately authorizes cleanup.

Recovery ceilings are one per permitted class per WU. This proposal permits
**only BLOCKED_TOOLING / restore-ready**. External-fact research and architecture
recovery are not authorized. Permission, authority, security, scope, no-progress
and exhausted-budget blockers are terminal; no recovery or alternative route.

## Execution and stop conditions after future owner approval

Before activation, verify this exact bootstrap commit is actually loaded by
OpenCode and live specialist readiness. This proposal grants neither loading
authority nor permission/profile changes. Bind mandate to the integrity-checked
approved Epic artifact revision and this exact WU contract hash.

Execute only the ordered, bounded sequence: build A → record A → tooling recovery
and resolution → complete verification/reviewer A → actual CHANGES_REQUIRED →
one repair → record B → fresh full verification/reviewer B → WU_COMPLETE.
Persist dispatch/session identities, candidate/review lineage, evidence IDs,
funding/counter snapshots and fresh-process recovery observations. Never infer
restart safety from a status call in the same process.

Stop on exhausted funds/cycle allowance, terminal blocker, unresolved ambiguity,
scope or authority mismatch, missing declared evidence, identical unresolved
failure or an outcome that does not establish the intended repair. No re-slicing,
top-up, mandate replacement, permission widening or fallback tool/session.

Successful WU completion may support an **EPIC_EXECUTION_VERIFIED** report only.
It does not authorize the controller's Epic `complete` action, owner acceptance,
automatic Epic completion, merge, deployment, release or another WU. Real
permission-denial examination requires a separate owner-approved negative probe;
it is not part of this successful-WU mandate and must not poison it. Overall
PHASE_4 remains UNVERIFIED until every frozen runtime gate is satisfied.
