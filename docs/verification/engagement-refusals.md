# Engagement scope and refused commands

An engagement is a room whose work is authorized offensive security. The room
card's **Engagement** section holds the **Scope** the client authorized, the
**Assets** the team found inside it, the **Findings** the team recorded, and the
**Refused commands** its scope turned away. A direct message holds none of the
four.

The scope is a list of authorized targets (`example.com`, `*.example.com`,
`10.0.0.0/24`), the hosts that are off limits, and an optional window. Before
a member's command runs, `createCommandScope` reads the hosts the command's
text would reach (`commandDestinations`). A host outside the scope, or a
command outside the window, is refused with a line that names the host and
restates the scope. Loopback is never part of a scope.

This is a heuristic on command text, not a sandbox. It is the record of what a
team reached for, not the only thing between a bot and a network.

## What an asset records

The **Assets** page is the engagement's inventory of the attack surface it found
inside the scope: each host, service, web app or endpoint, what it runs, the
banner that identified it, and the command, scan or source that turned it up.
The bot writes it with `engagement_asset`; the person reads it through
`GET /api/groups/:id/assets`. The route reads each asset against the room's
current scope, so one that has fallen out of scope is shown flagged rather than
silently dropped.

The store (`server/engagement-assets.ts`) keys an asset by its location, so a
scan that returns `https://app.example.com/` and a later
`https://app.example.com` are one entry whose first sighting keeps its time.
Like the findings and the refusals, it is room-scoped, fails closed on a damaged
file, and is never a place a command runs from.

```sh
node_modules/.bin/vitest run server/engagement-assets.test.ts \
  server/routes/engagement-assets.test.ts server/routes/groups-assets.test.ts \
  server/drivers/agents-asset-tool.test.ts \
  server/routes/engagement-assets-chain.test.ts
```

They prove, against the real store and the real routes:

- a location, a kind and how it was found are required, and an unknown kind is
  refused;
- the same location recorded twice refreshes the one asset, keeping its first
  sighting;
- `GET /api/groups/:id/assets` flags each asset against the room's scope, and
  answers 404 for an unknown room, 403 for a room this caller may not read, 400
  for a direct message, and passes an unknown method on;
- `engagement_asset` is offered in a room's turn and in no other conversation,
  and its record, update and list reach the internal route;
- an asset a bot records in the room's own thread is read in that room; one
  recorded in a parallel room job's thread is read in the room its opener ties it
  to; a bot's own thread is refused 409.

## What a refusal records

Every refusal is written, from the one place commands are checked, to the
room's own ledger (`server/engagement-refusals.ts`). The **Refused commands**
page reads it through `GET /api/groups/:id/refusals` and shows the most recent
first: the reason (a host outside the scope, or which side of the window), the
command, and how many times the same command was refused.

Two commands refused for the same reason are one entry, so a bot retrying a
command does not bury the ledger. A held secret in a command is masked before
it is written, since a person reads the command there. The store never blocks
a command: a damaged store records nothing and reads nothing rather than
failing the turn.

## Verify it against a fixture

The store, the route and the pages are covered by unit and DOM tests:

```sh
node_modules/.bin/vitest run server/engagement-refusals.test.ts \
  server/engagement-scope.test.ts server/routes/groups-refusals.test.ts \
  src/components/room-panel/EngagementPages.dom.test.ts
```

The two ends of a finding — the bot's `engagement_finding` call and the person's
read of the room — are joined in one test over one real store and the store's own
room resolution, so a finding recorded where a bot speaks is read where the person
looks:

```sh
node_modules/.bin/vitest run server/routes/engagement-findings-chain.test.ts
```

They prove, against the real store and the real route handler:

- a command outside the scope is refused with the host it reached for, and one
  inside it is not; a window refusal says which side;
- a repeated command is one entry whose `attempts` counts up;
- a refusal is reported once, with its room, from the one check;
- `GET /api/groups/:id/refusals` answers 404 for an unknown room, 403 for a
  room this caller may not read, 400 for a direct message, and passes an
  unknown method on so routing continues;
- a damaged store neither throws nor records, so no refusal can break a turn;
- a held secret in a command is masked before it reaches the ledger;
- the page lists the most recent refusal first and says nothing was refused
  when the ledger is empty.

The chain test proves, over one real store:

- a finding a bot records in the room's own thread is read through
  `GET /api/groups/:id/findings` in that room;
- a finding a parallel room job records in its own thread is read in the room
  its opener ties it to;
- an update by id changes the one finding the person then reads;
- a bot's own thread answers to no room, so a record there is refused 409 and
  the room's ledger stays empty.

## The client report

The **Findings** page's **Download report** button saves the room's scope and
findings as one markdown document the client keeps. The server renders it
(`shared/engagement-report.ts`) and hands it over from
`GET /api/groups/:id/report` as `text/markdown` with an attachment filename, so
the download and any other reader of the route see the same words. The report
is English only, like the transcript export: it is a document, not UI copy. A
room with no findings still reports its scope, so the document says what was
authorized even when nothing was found.

```sh
node_modules/.bin/vitest run shared/engagement-report.test.ts \
  server/routes/groups-report.test.ts
```

They prove:

- the report names the room, the authorized targets, the off-limits list and
  the window, and says so plainly when no scope was set;
- findings are worst first, `proven` counted apart from `suspected`, each with
  its target, status, evidence and detail, and an update time only once it has
  moved past its report;
- a title or target with a newline or a `|` cannot break the table;
- `GET /api/groups/:id/report` answers 404 for an unknown room, 403 for a room
  this caller may not read, 400 for a direct message, and passes an unknown
  method on so routing continues;
- the page saves the room's report from the button, offers it even with nothing
  found, and says so when the download is refused.

To see a real refusal end to end, launch a fixture
([README](README.md)), give a room a scope that excludes a host, and have a
member run a command that reaches it. The command is refused, the room's
**Refused commands** page shows it, and no traffic leaves the fixture.
