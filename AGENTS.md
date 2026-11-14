# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

UI changes follow [`DESIGN.md`](DESIGN.md).

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

## This fork (Parth Lab)

`main` is a fork of `milind-soni/OpenMausBot` rebranded to "Parth Lab". Keep it
synced by merging `upstream/main`; never use GitHub's "Discard commits" button,
which would delete the rebrand.

- Product name lives in `DEFAULT_BRAND.name` and `PRODUCT_NAME` in
  `src/lib/brand.ts` and `server/brand.ts`. The rebrand is scoped to those
  constants, the surfaces that read them (window titles, manifest, native
  window-title locales) and their tests — not a blanket rename of every source
  string. When a merge brings in a new test that pins the product name, update
  that test.
- The Parth Lab model-facing prose is about 2% larger than upstream's, so after
  a merge that touches the agents catalog, regenerate the goldens
  (`UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm vitest run server/drivers/agents-catalog-wire.test.ts
  server/drivers/agents-bridge-wire.test.ts`) and move `BUDGET_BASELINE` in
  `agents-catalog-wire.test.ts` to the new golden bytes.
