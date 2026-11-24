# Upstream picks

`main` is a fork of `milind-soni/OpenMausBot` rebranded to "Parth Lab".

`main` now carries `upstream/main` whole: commit `72a1c869ef` merged
`310e731edb` (182 commits) and reconciled the rebrand by hand, and every earlier
pick below came in with it. A later upstream commit is taken the same way, by
merging `upstream/main` again — not cherry-picked.

The table below stays as the record of what each pick fixed, and of the
resolutions its files need: the locales keep the fork's own keys beside
upstream's, and the engagement ledgers (`server/engagement.ts`,
`shared/engagement.ts`) exist only here, so a merge never touches them.

Every commit below was cherry-picked with `-n` against `ba583223f` and applied
without a conflict.

## Take these

| Commit | What it fixes | Files |
| --- | --- | --- |
| `995ee2cb0` | A cloud computer's tools were given a new credential every turn, so every follow-up stopped the bot's engine and started a new one. The thread now keeps one credential, so the engine and its context survive between turns. | `server/index.ts` |
| `e0293d60a` | A run stopped by its own limit keeps its exit code and the report it had already delivered. Before this, hitting the limit erased the report as well. | `server/routines.ts`, `server/routine-bounds.ts`, `server/routine-lines.ts`, locales |
| `d734dfb85` | Newly appended CRLF memory entries no longer fall out of eviction. | `server/workspace.ts` |
| `d6da38d17` | Memory recognizes notes written with CRLF line endings. | `server/memory-entries.ts` |
| `827ba816a` | Memory forgets matching details inside multiline notes. | `server/memory-forget.ts` |
| `ee20fa0a0` | Forget markers survive an append that fails. | `server/memory-forget.ts` |
| `64376f685` | A turn an OpenAI-compatible engine refuses as over its context window resends smaller instead of failing. | `server/drivers/chat-size-limit.ts`, `server/drivers/openai-chat.ts` |
| `04ccd3dad` | A scheduled routine run is retried when its cloud computer did not wake. | `server/routines.ts`, `server/routine-recovery.ts`, `server/routine-wake-retry.ts` |
| `f19e689d3` | Secrets are masked in rejected OpenAI tool arguments before the quote is cut. | `server/drivers/openai-chat.ts`, `server/drivers/openai-chat-protocol.ts` |
| `0af84856e` | Windows packaging extracts the CUA driver with System32 `tar`, and a driver that gives no version says why. | `scripts/prepare-cua-win.mjs`, `scripts/cua-binary-version.mjs` |

`e0293d60a` and `04ccd3dad` touch `src/locales/en.json` and `src/locales/pt-br.json`.
Both carry the Portuguese translation with them, so `pt-br` stays at 100%. Run
`pnpm i18n:check` after taking either.

`f19e689d3` is already in the tree. It arrived with `64376f685`, which touches
the same two driver files and carries the `redact` parameter that
`toolArguments` takes. Cherry-picking `f19e689d3` on top of `64376f685` applies
nothing, so take one or the other, not both.

## Take with a conflict

These are worth having, but each collides with the rebrand or with code the fork
changed. Resolve by hand, then run `pnpm i18n:check` and
`src/lib/server-word-contracts.test.ts`.

| Commit | What it fixes | Collides with |
| --- | --- | --- |
| `198b84350` | Claude and Codex compact their own sessions; the summary is written ahead of the limit. | locales, drivers |
| `0c885a280` | Idle engines close sooner under pressure; a memory cap per bot. | locales |
| `f2e6c73c2` | Suggests a new chat under the latest context compaction. | 4 locale files |
| `bbbb73f44` | An empty item does not erase the report a run delivered. | `server/routines.ts` |
| `30b570713` | Drops the import the empty-item fix left unused. | `server/routines.ts` |
| `670e995bd` | A sibling chat reads a hand-off without marking its results delivered. | coordination |
| `f126f8a4d` | Says macOS 13 is needed instead of loading the CUA driver on older Macs. | locales, and `electron/cua.mjs` next to a "Parth Lab" string |
| `1d4a88693` | Keeps "This computer" off, with the macOS 13 reason, on retry. | `electron/cua.mjs` |

## Do not take

- **A wholesale merge of `upstream/main`.** 186 commits touch `src/locales/`, and
  the fork's product name lives in 468 catalog strings plus hardcoded mirrors.
  The engagement ledgers are fork-only, so a merge brings nothing for them.
- **UI and design commits.** They fight `DESIGN.md` and the rebrand.
- **Mobile and iOS commits.** The fork ships no iOS app.
- **`feat:` commits.** New surface area to maintain, with no reliability payoff.
- **Open upstream pull requests.** 103 open ones mention "security", but they are
  platform infrastructure (CI permissions, OAuth, agent providers). None is
  offensive security.

## Known rebrand surface not listed in `AGENTS.md`

`AGENTS.md` scopes the rebrand to `DEFAULT_BRAND.name` / `PRODUCT_NAME` and a
short list of mirrors. The actual surface is wider:

```
135  "Parth Lab" occurrences
 51  files under electron/
 29  upstream commits touch those files
```

The 16 locale packs carry 468 more occurrences between them.

Most of these are hardcoded user-facing error strings, not reads of
`productName()` and not catalog entries, so they are English-only. Examples in
`electron/cua.mjs`:

```js
throw new Error("Packaged background CUA driver is missing; reinstall Parth Lab");
throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart Parth Lab`);
```

Every upstream commit that touches one of those 51 files needs the rebrand
re-applied by hand. `electron/main.mjs` alone accounts for 14 of the 29 commits.
Before taking a commit from the conflict list, check whether it lands in one of
them.
