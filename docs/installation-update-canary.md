# OpenCode installation and update canary

This is a required deployment gate, **not an executed runtime canary report**.

## Automated package inspection

Run `npm run check` under Node 20/22/24: `tests/plugin-install-canary.test.js` inspects the actual npm pack file list. This is necessary but not sufficient to prove live OpenCode compatibility.

## Clean install canary

1. In a disposable project and isolated OpenCode configuration, install this exact GitHub SHA with `opencode plugin add 'git+https://github.com/edugonch/agentic-engineering-tutor-system.git#<SHA>'`.
2. Restart OpenCode and verify the exact loaded package revision and managed agent registry.
3. Run a trivial owner-authorized WU: builder, freeze, declared checks, independent review, governed merge, complete.
4. Validate immutable receipt hashes, source/WU/candidate binding, historical replay and owner-config preservation.

## Update canary

1. Snapshot/read the previous journal and existing package hash without editing `.harness`.
2. Update the installed plugin with `opencode plugin update`; restart and verify loaded SHA.
3. Replay an older execution and receipts v2 without retroactive changes.
4. Run one CHANGES_REQUIRED case with four bounded defects and one consolidated repair in the same WU.
5. Reproduce npm EACCES/network/tooling failure; do not write `.npmrc` to the product.
6. Exercise all feature flags independently with exact evidence and ensure old paths remain valid.

## Rollback

Use a pinned previous plugin binary only if it can safely replay any newer events. Never restore older journals or rewrite contracts and receipts. Record SHA, CI run and independent review before merging.
