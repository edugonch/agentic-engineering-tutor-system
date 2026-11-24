# Project governance gates (Epic activation and closure)

The Harness core stays generic. A project may attach its own deterministic
governance command to the real Epic lifecycle actions by committing a
`harness.config.json` at the project root. This is how a project prevents
`complete` (which records `EPIC_EXECUTION_VERIFIED`) from succeeding while the
project's own coverage/closure rules are unmet.

## Configuration

```json
{
  "governance": {
    "epicActivationCommand": {
      "program": "npm",
      "args": ["run", "governance:epic-coverage", "--", "--activation", "{epic_id}"],
      "timeout_ms": 120000,
      "require_candidate_sha": false
    },
    "epicClosureCommand": {
      "program": "npm",
      "args": ["run", "governance:epic-coverage", "--", "--closure", "{epic_id}"],
      "timeout_ms": 120000,
      "require_candidate_sha": true
    }
  }
}
```

- Commands are **program + argv**, never a shell string. Arguments are passed
  verbatim; shell metacharacters are never interpreted.
- Commands run with the project root as the working directory.
- The file is optional: without it (or without a `governance` object), the
  Harness behaves exactly as before.
- A present-but-malformed file fails closed instead of silently disabling the
  gate.

### Placeholders

Expanded from durable execution state:

| Placeholder        | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `{epic_id}`        | Canonical Epic id recorded on the mandate at approval.               |
| `{execution_id}`   | Harness execution id.                                                |
| `{mandate_id}`     | Approved mandate id.                                                 |
| `{candidate_id}`   | Harness candidate id for the final WU.                               |
| `{candidate_sha}`  | Final merge commit SHA, else the bound reviewed head SHA.            |
| `{merge_commit_sha}` | Recorded merge commit SHA (may be empty for no-merge mandates).    |
| `{final_wu_id}`    | Terminal WU of the frozen sequence.                                  |

A configured gate that references a placeholder with no value throws a
fail-closed error (for example `EPIC_GATE_MISSING_EPIC_ID` or
`EPIC_GATE_MISSING_CANDIDATE_SHA`).

## Lifecycle points

- `init` / `approve_mandate`: if `epicActivationCommand` is configured, it must
  pass before the mandate is committed. The mandate must carry `epic_id`.
- `complete`: if `epicClosureCommand` is configured, it must pass before any
  `COMPLETE` event is committed. The gate receives the final candidate SHA and
  must validate its evidence against it. A failure leaves the execution open; no
  `COMPLETE` event is written.
- `amend_mandate` may fill in an absent `epic_id` once; it can never change an
  existing one.

## Audit receipt

On success the gate receipt is embedded in the committed event body under
`governance`, so it is part of the append-only event log and its operation hash:

```json
{
  "gate": "epic-closure",
  "config_path": "<project>/harness.config.json",
  "config_sha256": "...",
  "command": ["npm", "run", "governance:epic-coverage", "--", "--closure", "EPIC-02"],
  "epic_id": "EPIC-02",
  "candidate_id": "cand-...",
  "candidate_sha": "<40-char sha>",
  "merge_commit_sha": "<40-char sha>",
  "final_wu_id": "WU-...",
  "exit_code": 0,
  "timed_out": false,
  "truncated": false,
  "ok": true,
  "timeout_ms": 120000,
  "require_candidate_sha": true,
  "duration_ms": 1234,
  "stdout_sha256": "...",
  "stderr_sha256": "...",
  "checked_at": "2026-11-24T00:00:00.000Z"
}
```

The command also receives `HARNESS_EPIC_ID`, `HARNESS_EXECUTION_ID`,
`HARNESS_MANDATE_ID`, `HARNESS_CANDIDATE_ID`, `HARNESS_CANDIDATE_SHA`,
`HARNESS_MERGE_COMMIT_SHA`, `HARNESS_FINAL_WU_ID`, `HARNESS_GATE_PHASE` and
`HARNESS_GOVERNANCE_GATE=1` in its environment. The process environment is
inherited; the gate must not print secrets.

Only the hashes (not stdout/stderr content) are durable. The command argv is
durable in the event body, so never put secrets in gate arguments.

## Config pinning

When a closure gate is configured at approval, the controller persists
`governance_closure_required` and the config `sha256`. `complete` fails closed
with `EPIC_GATE_CONFIG_DRIFT` if the working-tree config changed after approval,
and with `EPIC_CLOSURE_GATE_DISABLED` if the closure gate is removed. A genuine
gate change requires a new approved mandate/amendment, not an in-place edit.

## Failure codes

- `EPIC_GATE_CONFIG_UNREADABLE` / `EPIC_GATE_CONFIG_INVALID`
- `EPIC_GATE_MISSING_EPIC_ID` / `EPIC_GATE_MISSING_CANDIDATE_SHA`
- `EPIC_GATE_UNKNOWN_PLACEHOLDER` / `EPIC_GATE_PHASE_INVALID`
- `EPIC_CLOSURE_GATE_DISABLED` / `EPIC_GATE_CONFIG_DRIFT`
- `EPIC_ACTIVATION_GATE_FAILED` / `EPIC_CLOSURE_GATE_FAILED` (carry
  `gate_receipt` for diagnostics)

## Compatibility

No configuration means no behavior change. The gate is generic: the Harness
does not know or embed any project's rules. The project owns the command, the
evidence format and its own verifier.
