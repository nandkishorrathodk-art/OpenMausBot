// The engagement asset inventory, across the one seam index.ts wires: a bot records from the conversation it speaks
// in, and the person reads the room that same conversation answers to, each asset flagged against the room's scope.
// Both routes run against one real store and the real room resolution, so an asset recorded in a room job's own
// thread is read in its room.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { EngagementAssetsStore, assetLocationHost, EngagementScopeStore, hostInScope } from "../engagement.ts";
import { createThreadSource } from "../host/thread-source.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createEngagementAssetInternalRoutes, ASSETS_PATH } from "./engagement-assets.ts";
import { createGroupRoutes, type GroupRouteDeps } from "./groups.ts";
import type { RouteContext } from "./table.ts";

const sonnet = { instanceId: "claude", model: "claude-sonnet-5" } as never;
/** The shape room-jobs.ts opens a parallel room job's thread with: it answers to the room by its opener. */
const roomJobOpener = (senderId: string, roomThreadId: string) =>
  ({ botId: senderId, name: "Chief", threadId: roomThreadId, kind: "work", roomLane: true, at: Date.now() }) as const;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

/** Both routes index.ts builds, over one store, the store's own room resolution and the room's scope. */
function chain() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const room = store.createGroup("Engagement", [bot.id]);
  const assets = new EngagementAssetsStore(`${DATA_DIR}/engagement-assets.json`);
  const scopes = new EngagementScopeStore(`${DATA_DIR}/engagement-scopes.json`);
  scopes.set(room.id, { targets: ["*.example.com"], offLimits: [] });
  const { roomOfThread } = createThreadSource(store);

  const internal = createEngagementAssetInternalRoutes({ assets, roomOf: roomOfThread });
  const record = async (threadId: string, body: unknown) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await internal({
      method: "POST", path: ASSETS_PATH, res: {} as ServerResponse,
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
    scope: scopes,
    canManageScope: () => true,
    findings: { list: () => [] },
    assets,
    assetInScope: (roomId: string, location: string) => {
      const scope = scopes.get(roomId);
      const host = assetLocationHost(location);
      return scope !== null && host !== null && hostInScope(scope, host);
    },
  } as unknown as GroupRouteDeps);
  const read = async (roomId: string) => {
    const sent: Array<{ status: number; body: any }> = [];
    await groupRoutes({
      req: { headers: {} } as unknown as IncomingMessage, res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/assets`), path: `/api/groups/${roomId}/assets`,
      method: "GET", auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    return sent[0]!;
  };
  return { store, bot, room, record, read };
}

const asset = { action: "record", location: "https://api.example.com", kind: "web-app", service: "nginx 1.25.3", discoveredBy: "nmap -sV api.example.com" };

describe("an asset crosses from the bot that recorded it to the person who reads the room", () => {
  it("is read in the room, flagged in scope, when the bot speaks in the room's own thread", async () => {
    const { room, record, read } = chain();
    const wrote = await record(room.threadId, asset);
    expect(wrote.status).toBe(200);
    const listed = await read(room.id);
    expect(listed.status).toBe(200);
    expect(listed.body.assets).toHaveLength(1);
    expect(listed.body.assets[0]).toMatchObject({ location: "https://api.example.com", kind: "web-app", service: "nginx 1.25.3", inScope: true });
  });

  it("flags an asset outside the room's scope, which the bot should not have recorded", async () => {
    const { room, record, read } = chain();
    await record(room.threadId, { ...asset, location: "https://elsewhere.test" });
    const listed = await read(room.id);
    expect(listed.body.assets[0]).toMatchObject({ location: "https://elsewhere.test", inScope: false });
  });

  it("records nothing from a bot's own thread, which answers to no room", async () => {
    const { room, bot, record, read } = chain();
    const refused = await record(bot.threadId, asset);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("engagement room");
    expect((await read(room.id)).body.assets).toEqual([]);
  });

  it("is read in the room a parallel room job's own thread belongs to", async () => {
    const { store, room, bot, record, read } = chain();
    const job = store.createTask(bot.id, `${room.name} · scan api.example.com`, false, undefined, roomJobOpener(bot.id, room.threadId));
    expect(job).toBeTruthy();
    const wrote = await record(job!.threadId, asset);
    expect(wrote.status).toBe(200);
    expect((await read(room.id)).body.assets).toHaveLength(1);
  });

  it("updates the one asset by its id, and the person reads the new service", async () => {
    const { room, record, read } = chain();
    const wrote = await record(room.threadId, asset);
    const id = wrote.body.asset.id;
    const updated = await record(room.threadId, { action: "update", id, service: "nginx 1.26.0" });
    expect(updated.status).toBe(200);
    expect(updated.body.asset).toMatchObject({ id, service: "nginx 1.26.0" });
    const listed = await read(room.id);
    expect(listed.body.assets).toHaveLength(1);
    expect(listed.body.assets[0]).toMatchObject({ id, service: "nginx 1.26.0" });
  });
});
