// The engagement findings ledger, across the one seam index.ts wires: a bot records from the conversation it
// speaks in, and the person reads the room that same conversation answers to. Both routes run against one real
// store and the real room resolution, so a finding recorded in a room job's own thread is read in its room.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { EngagementFindingsStore, EngagementScopeStore } from "../engagement.ts";
import { createThreadSource } from "../host/thread-source.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createEngagementFindingInternalRoutes, FINDINGS_PATH } from "./engagement-findings.ts";
import { createGroupRoutes, type GroupRouteDeps } from "./groups.ts";
import type { RouteContext } from "./table.ts";

const sonnet = { instanceId: "claude", model: "claude-sonnet-5" } as never;
/** The shape room-jobs.ts opens a parallel room job's thread with: it answers to the room by its opener. */
const roomJobOpener = (senderId: string, roomThreadId: string) =>
  ({ botId: senderId, name: "Chief", threadId: roomThreadId, kind: "work", roomLane: true, at: Date.now() }) as const;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/** Both routes index.ts builds, over one store and the store's own room resolution. */
function chain() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const room = store.createGroup("Engagement", [bot.id]);
  const findings = new EngagementFindingsStore(`${DATA_DIR}/engagement-findings.json`);
  const { roomOfThread } = createThreadSource(store);

  const internal = createEngagementFindingInternalRoutes({ findings, roomOf: roomOfThread, scopeOf: () => null });
  const record = async (threadId: string, body: unknown) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await internal({
      method: "POST", path: FINDINGS_PATH, res: {} as ServerResponse,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as never,
      botId: bot.id, threadId, readBody: async () => body,
    });
    expect(out).toBeUndefined();
    return sent[0]!;
  };

  const groupRoutes = createGroupRoutes({
    store, cloudHome: false,
    visibleFor: () => ({ group: () => true }) as never,
    actorKey: () => "person",
    threadStarters: { set: () => {} },
    createChannel: () => room,
    publicGroupState: (g: { id: string }) => g as unknown as WireGroup,
    scope: new EngagementScopeStore(`${DATA_DIR}/engagement-scopes.json`),
    canManageScope: () => true,
    findings,
  } as unknown as GroupRouteDeps);
  const read = async (roomId: string) => {
    const sent: Array<{ status: number; body: any }> = [];
    await groupRoutes({
      req: { headers: {} } as unknown as IncomingMessage, res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/findings`), path: `/api/groups/${roomId}/findings`,
      method: "GET", auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  return { store, bot, room, record, read };
}

const finding = { action: "record", target: "api.example.com", title: "Open redirect", severity: "high", status: "suspected", evidence: "curl -I https://api.example.com/go?next=//evil.test" };

describe("a finding crosses from the bot that recorded it to the person who reads the room", () => {
  it("is read in the room when the bot speaks in the room's own thread", async () => {
    const { room, record, read } = chain();
    const wrote = await record(room.threadId, finding);
    expect(wrote.status).toBe(200);
    const listed = await read(room.id);
    expect(listed.status).toBe(200);
    expect(listed.body.findings).toHaveLength(1);
    expect(listed.body.findings[0]).toMatchObject({ target: "api.example.com", title: "Open redirect", severity: "high", status: "suspected" });
  });

  it("records nothing from a bot's own thread, which answers to no room", async () => {
    const { room, bot, record, read } = chain();
    const refused = await record(bot.threadId, finding);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("engagement room");
    expect((await read(room.id)).body.findings).toEqual([]);
  });

  it("is read in the room a parallel room job's own thread belongs to", async () => {
    const { store, room, bot, record, read } = chain();
    const job = store.createTask(bot.id, `${room.name} · scan api.example.com`, false, undefined, roomJobOpener(bot.id, room.threadId));
    expect(job).toBeTruthy();
    const wrote = await record(job!.threadId, finding);
    expect(wrote.status).toBe(200);
    expect((await read(room.id)).body.findings).toHaveLength(1);
  });

  it("updates the one finding by its id, and the person reads the new status", async () => {
    const { room, record, read } = chain();
    const wrote = await record(room.threadId, finding);
    const id = wrote.body.finding.id;
    const updated = await record(room.threadId, { action: "update", id, status: "proven", evidence: "the redirect returns 302 to evil.test", proof: "curl -i https://acme.test/?next=evil.test -> 302 Location: https://evil.test" });
    expect(updated.status).toBe(200);
    expect(updated.body.finding).toMatchObject({ id, status: "proven" });
    const listed = await read(room.id);
    expect(listed.body.findings).toHaveLength(1);
    expect(listed.body.findings[0]).toMatchObject({ id, status: "proven" });
  });
});
