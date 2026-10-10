# Project instructions and independent source access

Harness includes the project's root `AGENTS.md` and `skills/ROUTER.md` (when
present) with content hashes in Harness agent context. Changes are reread on the
next turn. Agents follow that router, read project state, and explicitly load
only activated skills and applicable deeper `AGENTS.md` files through
`harness_read_project_instructions`. Instructions do not override native
permissions, confer new business authority, or become a compiled policy simply
because they contain a keyword.

For live authority, prefer the project's existing MCP connection. The new
`harness_read_external_source` is a separate trusted read transport available to
reviewer and researcher as well as builder and orchestrator. It does not require
shell permission and does not run candidate code with external credentials.

## One fallback

Supply `provider: one`, `authority_paths` containing the WU/source references,
and use operations `list`, `find`, `knowledge`, then `read`. Discovery returns
actual connection/action IDs and documentation; do not invent them. `read`
requires the exact `source_id` to occur in the supplied authority and in
`path_variables`. Supply `platform`, `action_id`, `connection_key`, and optional
`query_params` from the retrieved action documentation.

The adapter uses pinned `@withone/cli@2.6.0` via npx, fetched if necessary. It
resolves the existing project's One config before the global fallback, retaining
connection/action/knowledge restrictions and `.onerc` overrides, then narrows
execution to GET. It runs in a disposable private home/cwd. The original config
and project tree are not modified. The CLI is never invoked in the repository:
even an informational CLI command may automatically refresh project skills.
The adapter loads action documentation and checks a dry-run's method and exact
source path before the real call. Write commands, workflow execution, output
files, custom headers, caller environment and shell expressions are unavailable.
OAuth/bootstrap requiring an external step remains an explicit environment
prerequisite. The orchestrator performs setup already authorized by the project;
the reviewer does not request a new business decision.

Implementation references: installed OpenCode SDK 2.0.25; One upstream
`withoneai/cli` commit `09094ad5bb1df514e8b142a7f4a5b9a32253b951`, version 2.6.0,
`src/lib/config.ts`, `src/commands/actions.ts`, `src/cli.ts`.
https://www.withone.ai/docs/cli
https://www.withone.ai/docs/mcp

## GitHub fallback

Use `provider: github`, `operation: read`, and an `endpoint` starting with
`repos/OWNER/REPO/` for issues, pulls, commits, contents, workflow runs or check
runs. The repository must occur in supplied project authority. The installed
`gh` executes REST GET with existing authentication. No aliases, extensions,
GraphQL, arbitrary hosts, credential display or mutation flags are accepted.

## Evidence and admission

Every response carries observation time, authority fingerprint and content hash.
It represents a single transport response: consumers must inspect API errors,
follow pagination, record remote versions and detect source drift. It is not
review PASS or proof that a cached snapshot remains current.

BUILD and REVIEW both recheck the declared verification capabilities. The actual
subagent launch rechecks again before a durable launch claim; disappearing tools
cannot strand a claimed worker. Existing controller budget checks remain in
charge of allocations (already-reserved time is not charged twice). Configured
verification-tool denials are reported; native session permission evaluation
still controls the actual call. Registry presence does not prove authentication
or exact-document access. The diagnostic explicitly states that scope.

## Validation and remaining live check

Unit/integration tests cover context refresh, path traversal/symlinks, ownership,
configured denial, malformed capabilities, launch recovery after tool removal,
GET/exact-source enforcement, credential isolation/cleanup/redaction, pagination
preservation and no remote execution on a write preview. Five isolated mutations
must fail those tests. Run `npm run check` and `npm run test:sources:mutations`.

The private ALFRAN runtime/credentials are not available in this checkout. After
plugin update, the live canary is a fresh WU066 reviewer using the existing
candidate, live canonical Drive revision and complete pagination, followed by
normal review/CI/governed merge. Do not claim that canary or Epic completion from
these controlled-host tests. The implementation does not automatically interpret
arbitrary Markdown into a complete source-permission policy or provision OAuth.
