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
- The 16 locale packs in `src/locales/` name the product in their UI strings
  (~400 entries), and several source constants are exact mirrors of a catalog
  string rather than reads of `productName()`: the chat/server notices
  (`server/chat-notices.ts`, `server/user-errors.ts`, `server/routine-lines.ts`,
  `server/drivers/driver-notices.ts`, `server/host/brief.ts`, `shared/*.ts`) and
  a few electron sources (`lending-indicator.mjs` tray tip, `lent-screen-failures.mjs`,
  `cua.mjs`, `cloud-send.mjs`, `one-home-main.mjs`, `update-errors.mjs`). A
  catalog edit must move those mirrors and their test pins in the same change;
  `pnpm i18n:check` and `src/lib/server-word-contracts.test.ts` catch drift.
  Never rename protocol identifiers or data-directory paths: `X-OpenMausBot-*`
  headers, the `"OpenMausBot tool proxy"` client name, `OPENMAUSBOT_TOKEN`,
  `electron.app.OpenMausBot`, `~/.openmausbot`.
- The Parth Lab model-facing prose is about 2% larger than upstream's, so after
  a merge that touches the agents catalog, regenerate the goldens
  (`UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm vitest run server/drivers/agents-catalog-wire.test.ts
  server/drivers/agents-bridge-wire.test.ts`) and move `BUDGET_BASELINE` in
  `agents-catalog-wire.test.ts` to the new golden bytes.
- The product is an autonomous offensive-security company, and the model-facing
  prose carries that framing rather than a generic assistant's: the operator
  identity, engagement discipline and attacker mindset in
  `server/system-prompt.ts`; the engagement intake and consolidated report in
  `server/chief-of-staff.ts`; the finding report in `server/reply-habits.ts`;
  the setup-card capability list in `server/setup-suggestions.ts`; and the
  default watch in `server/host/default-watch.ts`, whose `runs` check already
  reads other routines' runs. Keep it autonomy-preserving: state the posture and
  the reasoning, never a fixed playbook or a tool-name script the model must
  follow. `server/testing/fixtures/setup-suggestions-eval.json` records the
  exact prompt for each scenario, so a change to `setupSuggestionPrompt` means
  regenerating those `prompts` entries (they are a pure function of the
  scenario) while leaving the recorded `replies` alone.
