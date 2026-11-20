import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { EngagementScopeStore } from "../engagement.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createGroupRoutes, type GroupRouteDeps } from "./groups.ts";
import { PASS, type RouteContext } from "./table.ts";

const sonnet = { instanceId: "claude", model: "claude-sonnet-5" } as never;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const room = store.createGroup("Engagement", [bot.id]);
  const dm = store.createGroup("Scout DM", [bot.id], true);
  const scopes = new EngagementScopeStore(`${DATA_DIR}/engagement-scopes.json`);
  const deps = {
    store, cloudHome: false,
    visibleFor: () => ({ bot: () => true, bots: () => true }) as never,
    actorKey: () => "person",
    threadStarters: { set: () => {} },
    createChannel: () => room,
    publicGroupState: (g: { id: string }) => g as unknown as WireGroup,
    scope: scopes,
    canManageScope: (auth: RequestAuth) => auth.kind === "loopback" ? auth.trust !== "service" : auth.scopes.includes("admin"),
  } as unknown as GroupRouteDeps;
  const handler = createGroupRoutes(deps);
  const call = async (roomId: string, method: string, body: unknown = {}, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] } as RequestAuth) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/scope`),
      path: `/api/groups/${roomId}/scope`,
      method,
      auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    return { out, sent };
  };
  return { store, bot, room, dm, call };
}

describe("GET/PUT /api/groups/:id/scope", () => {
  it("round-trips a scope, normalized, and clears with null", async () => {
    const { room, call } = fixture();
    expect((await call(room.id, "GET")).sent[0]).toEqual({ status: 200, body: { scope: null } });
    const put = await call(room.id, "PUT", { scope: { targets: ["Example.com"], offLimits: [] } });
    expect(put.sent[0]!.status).toBe(200);
    expect(put.sent[0]!.body.scope.targets).toEqual(["example.com"]);
    expect((await call(room.id, "GET")).sent[0]!.body.scope.targets).toEqual(["example.com"]);
    expect((await call(room.id, "PUT", { scope: null })).sent[0]).toEqual({ status: 200, body: { scope: null } });
  });

  it("refuses an empty scope, an unknown field and an unknown room", async () => {
    const { room, call } = fixture();
    expect((await call(room.id, "PUT", { scope: { targets: [] } })).sent[0]!.status).toBe(400);
    expect((await call(room.id, "PUT", { scope: { targets: ["a.com"], junk: 1 } })).sent[0]!.status).toBe(400);
    expect((await call("nope", "GET")).sent[0]!.status).toBe(404);
  });

  it("gives a direct message no engagement scope", async () => {
    const { dm, call } = fixture();
    expect((await call(dm.id, "GET")).sent[0]!.status).toBe(400);
  });

  it("refuses a bot's shell: a service-trust loopback caller can neither read nor set a scope", async () => {
    const { room, call } = fixture();
    const shell = { kind: "loopback", scopes: ["admin"], trust: "service" } as RequestAuth;
    expect((await call(room.id, "GET", {}, shell)).sent[0]!.status).toBe(403);
    expect((await call(room.id, "PUT", { scope: { targets: ["evil.test"] } }, shell)).sent[0]!.status).toBe(403);
    // A bot with no admin scope is refused too, and the refusal is a scope, not a scope value.
    expect((await call(room.id, "PUT", { scope: { targets: ["evil.test"] } }, { kind: "session", scopes: [] } as unknown as RequestAuth)).sent[0]!.status).toBe(403);
  });

  it("declines every other path so routing continues", async () => {
    const { room, call } = fixture();
    expect((await call(room.id, "DELETE")).out).toBe(PASS);
  });
});
