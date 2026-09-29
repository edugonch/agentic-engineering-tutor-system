# Third-party attribution

## OpenDesign

`templates/.opencode/agents/harness-designer.md` adapts the five-dimension design self-critique from OpenDesign's `packages/contracts/src/prompts/discovery.ts`:

- Upstream: [nexu-io/open-design](https://github.com/nexu-io/open-design)
- Source revision inspected: [`64710082d02c041da47bf8c6d6c5316b36b28b22`](https://github.com/nexu-io/open-design/tree/64710082d02c041da47bf8c6d6c5316b36b28b22)
- Source file: [`packages/contracts/src/prompts/discovery.ts`](https://github.com/nexu-io/open-design/blob/64710082d02c041da47bf8c6d6c5316b36b28b22/packages/contracts/src/prompts/discovery.ts)
- Copyright: Copyright 2026 Open Design contributors
- License: Apache License 2.0; the upstream license text is preserved at `licenses/OpenDesign-Apache-2.0.txt`.

The Harness adaptation renames the critique dimensions for project-interface work and places them inside one authorized WU. It adds OpenCode-specific agent boundaries, story/WU authority, existing-project design context, implementation limits, accessibility checks, and truthful verification reporting. It does not copy OpenDesign's runtime, tools, artifact protocol, prompt assembly, design-system catalogue, or agent architecture. No upstream `NOTICE` file was present at the inspected revision.
