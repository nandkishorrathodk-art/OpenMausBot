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
which would delete the rebrand. [`docs/upstream-picks.md`](docs/upstream-picks.md)
lists the individual upstream commits worth taking, which ones collide with the
rebrand, and the rebrand surface `electron/` carries that this file does not.

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
- An engagement runs in a room, and only a room: the scope, findings and
  refusals stores are keyed by `groupId`, `GET/PUT /api/groups/:id/scope` answers
  400 for a DM, and the scope line reaches a turn only through
  `commandScope.prompt(readyGroup.id)` in the room prompt. The Chief's intake in
  `server/chief-of-staff.ts` therefore tells it to create the room with
  `manage_room` when an engagement arrives, and `manage_room`'s description in
  `server/drivers/agents-catalog.ts` allows creation for that reason too — keep
  the two in step, since the description is a golden
  (`server/drivers/agents-catalog-goldens/`) and the intake text is pinned by
  `server/chief-of-staff.test.ts` and budgeted in `turn-prompt-budget.test.ts`.
  Only a person who holds the authorization may set a scope: never make the
  scope bot-writable, or a bot could widen the boundary it is checked against.
- The engagement ledger (`server/engagement-findings.ts`) is the room-scoped
  record of what the team has found, validated and fixed. Its `engagement_finding`
  tool is room-only: the catalog shows it through `ROOM_ONLY_TOOL_NAMES`, so
  adding such a tool moves only the two room goldens and their `BUDGET_BASELINE`
  entries while every other profile stays byte-identical. Its internal route
  (`server/routes/engagement-findings.ts`) resolves the room from the caller's own
  conversation rather than the body, and its path is in
  `server/host/outside-fence.ts`'s list, so a confined turn writes and reads only
  where it speaks.
- The engagement scope (`server/engagement-scope.ts`) and the findings ledger are
  wired to a person-facing surface in the room panel: `EngagementScopePage` and
  `EngagementFindingsPage` under `src/components/room-panel/` read and write
  `GET/PUT /api/groups/:id/scope` (owner or admin; a bot's shell is refused) and
  `GET /api/groups/:id/findings`, reached from the room card's Engagement section.
  A direct message has neither, and both the room card and the server enforce it:
  the scope and findings routes answer 400 for a DM, and the internal findings
  route answers 409, so no path records a finding a person can never read. The
  two records' shapes live in `shared/engagement.ts`, which both the server
  modules and the pages import, so a field change moves one file.
- What a refused command reached for is itself a record: `EngagementRefusalsStore`
  (`server/engagement-refusals.ts`) keeps, per room, the commands the scope refused,
  with the hosts they reached for or which side of the window they fell outside. The
  store is fed from the one place commands are checked — `createCommandScope`'s
  `onRefusal` callback, called from `server/index.ts` — so a refusal can never run
  unrecorded, and it is best-effort: a damaged store never blocks a command.
  `EngagementRefusalsPage` reads `GET /api/groups/:id/refusals` (400 for a DM, 403
  for a room this caller may not read) and shows the most recent refusal first.
  What is still open: `createCommandScope`'s check is a heuristic on command text
  rather than a sandbox. It reads a destination written as one integer
  (`0xc0a80101`, `3232235777`) and bash's `/dev/tcp/host/port`, but an address
  assembled inside a script or reached through a redirect is still not seen, so
  it bounds an honest operator's mistakes and is not a containment boundary.
- A card outlives the turn that asked: stopping that turn marks its secret and
  connector cards `stopped`, and a value provided afterwards is recorded
  (`provided: true`) but starts nothing — `resumeSecretCard` in
  `server/host/secret-cards.ts` resumes no stopped card, so a cancelled task
  never comes back to life through a card. The engagement report counts every
  status in one `By status` line, so its numbers always add up to `Findings`.
- When a rebrand reaches a string, move its verbatim twin in the same change.
  `src/lib/phone-setup.ts`'s `PUBLIC_ACCOUNT_MESSAGES` matches
  `electron/companion-account-messages.mjs`'s `FRIENDLY_MESSAGES` by regex, and
  `electron/data-dir-lease.mjs` keeps a hardcoded fallback of the catalog's
  `native.boot.sharedFolderAdvice`, so renaming one half leaves the pair broken
  or the app showing two names on one surface.

## Building the Windows installer locally

`pnpm package:win` assumes Windows x64. On Linux it works if wine can run the
Windows NSIS stub (32-bit) and rcedit. Install both wine bitnesses first:

```sh
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y --no-install-recommends wine64 wine32:i386 unzip
```

Debian ships the loaders as `/usr/lib/wine/wine64` and `/usr/lib/wine/wine`
without a `wine` command on `PATH`, and electron-builder spawns bare `wine`.
Install a shim and initialise the prefix once with the 32-bit loader so
`syswow64/ntdll.dll` exists:

```sh
printf '#!/bin/sh\nexport WINEDEBUG=-all\nexport XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp}\nexec /usr/lib/wine/wine64 "$@"\n' \
  | sudo tee /usr/local/bin/wine && sudo chmod +x /usr/local/bin/wine
rm -rf ~/.wine && WINEDEBUG=-all /usr/lib/wine/wine wineboot --init
```

Two prepare scripts refuse to run off Windows and stage only the host platform,
so stage those targets by hand before `electron-builder`:

- `scripts/prepare-android-tools.mjs` — unzip `platform-tools-latest-windows.zip`
  (dl.google.com) into `dist-native/android-platform-tools/win32/`.
- `scripts/prepare-cua-win.mjs` — it throws on non-win32 and unpacks a Windows
  SDK. The Windows CUA tree (`cua-driver.exe`, `cua-driver-background.exe`,
  `cua-sdk/cua-sdk.mjs`, `cua-sdk/native/*`) can be staged from the published
  release zip (`trycua/cua` tag `cua-driver-rs-v0.45.4`,
  `...windows-x86_64-binary.zip`) plus the `@trycua/cua-driver-win32-x64-msvc`
  npm package. Verify the executable with `wine cua-driver.exe --version` and
  esbuild the `@trycua/cua-driver/embedded` entry, patching the same
  `resolveLibPath` override the script patches.

Then:

```sh
pnpm build && pnpm build:server && pnpm build:companion && pnpm build:updater
pnpm build:cloudflared --target win32-x64
pnpm build:browser --target win32-x64
pnpm build:duckdb --target win32-x64
pnpm build:cua:win   # only on Windows; otherwise stage the tree as above
WINEDEBUG=-all electron-builder --win --publish never
```

`electron-builder` emits `release/OpenMausBot-<version>-setup.exe`. The
`productName`/`artifactName` in `electron-builder.yml` still read `OpenMausBot`,
which is the installer's filename and shortcut name; the in-app name a person
sees comes from `PRODUCT_NAME` in `src/lib/brand.ts`. Check the payload with
`7za l release/*-setup.exe` (it is an NSIS archive) before publishing. The build
is unsigned, so Windows SmartScreen warns on first run.


## Known failing tests on a clean `main`

These fail before any change; do not treat them as regressions:

- `server/host/chief-notices-retry.test.ts` — two "a run stopped to free memory" cases.
- `server/delta-context.e2e.test.ts` — "does not hand the model a queued follow-up that a restart recovered with an unknown outcome".
- `server/cloud-computer-once.test.ts` — "ends the command and what it started, by the process id the call recorded" (needs POSIX process control the sandbox lacks).
- `server/drivers/codex.test.ts` — the two "leaves none of a kept process's children running once it is stopped/killed while idle" cases (same process-control limit: the grandchild outlives the kill).
- `server/bot-box/hostile-home.test.ts` — the npm `.npmrc` case.
- `scripts/docker-image.test.ts` — "installs the engines once more when one does not start".
- `server/index.test.ts` — "saves a goal run's turn budget beside the room timeout without clearing it" passes alone but fails inside the full file: an earlier case leaves `rooms.turnTimeoutMinutes` set.
- `server/index.test.ts` — "keeps credential-card ownership stable while an encrypted phone save is in flight" expects `{ provided: true, resumed: false }` and gets `resumed: true`, on every commit checked back to `4b2591c42`, alone or in the full file.

Run the suites a change touches (`npx vitest run <files>`), not the whole tree.

## Adding a field to a Chief tool

A `create_bot` field lives in five places, and a miss shows up as the Chief
reporting success while nothing changed:

1. `TOOL_DEFINITIONS` in `server/drivers/agents-catalog.ts` (what the model sees).
2. The `api("/api/internal/create-bot", …)` body in `server/drivers/agents-call.ts`
   — the tool's arguments are rebuilt by hand here, so an unlisted key is dropped
   silently before the request is made.
3. `CreateBotFields` and `createBotFields()` in `server/create-bot-fields.ts`.
4. The validation and the `plan` fields in the `POST /api/internal/create-bot`
   handler in `server/index.ts`.
5. The goldens: `UPDATE_AGENTS_CATALOG_GOLDENS=1 npx vitest run
   server/drivers/agents-catalog-wire.test.ts`, then move `BUDGET_BASELINE` in
   that file to the new byte counts it prints.
