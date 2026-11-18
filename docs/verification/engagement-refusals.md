# Engagement scope and refused commands

An engagement is a room whose work is authorized offensive security. The room
card's **Engagement** section holds the **Scope** the client authorized, the
**Findings** the team recorded, and the **Refused commands** its scope turned
away. A direct message holds none of the three.

The scope is a list of authorized targets (`example.com`, `*.example.com`,
`10.0.0.0/24`), the hosts that are off limits, and an optional window. Before
a member's command runs, `createCommandScope` reads the hosts the command's
text would reach (`commandDestinations`). A host outside the scope, or a
command outside the window, is refused with a line that names the host and
restates the scope. Loopback is never part of a scope.

This is a heuristic on command text, not a sandbox. It is the record of what a
team reached for, not the only thing between a bot and a network.

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

To see a real refusal end to end, launch a fixture
([README](README.md)), give a room a scope that excludes a host, and have a
member run a command that reaches it. The command is refused, the room's
**Refused commands** page shows it, and no traffic leaves the fixture.
