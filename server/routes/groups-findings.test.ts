import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { EngagementFindingsStore } from "../engagement-findings.ts";
import { EngagementScopeStore } from "../engagement-scope.ts";
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
  const findings = new EngagementFindingsStore(`${DATA_DIR}/engagement-findings.json`);
  findings.record(room.id, { target: "api.example.com", title: "Open redirect", severity: "high", status: "suspected", evidence: "curl -I" });
  const deps = {
    store, cloudHome: false,
    visibleFor: () => ({ group: () => true }) as never,
    actorKey: () => "person",
    threadStarters: { set: () => {} },
    createChannel: () => room,
    publicGroupState: (g: { id: string }) => g as unknown as WireGroup,
    scope: new EngagementScopeStore(`${DATA_DIR}/engagement-scopes.json`),
    canManageScope: () => true,
    findings,
  } as unknown as GroupRouteDeps;
  const handler = createGroupRoutes(deps);
  const call = async (roomId: string, method: string, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] } as RequestAuth, visible = true) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/findings`),
      path: `/api/groups/${roomId}/findings`,
      method,
      auth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    return { out, sent, visible };
  };
  return { store, room, findings, call, deps };
}

describe("GET /api/groups/:id/findings", () => {
  it("lists the room's findings", async () => {
    const { room, call } = fixture();
    const answer = await call(room.id, "GET");
    expect(answer.sent[0]!.status).toBe(200);
    expect(answer.sent[0]!.body.findings.map((finding: { title: string }) => finding.title)).toEqual(["Open redirect"]);
  });

  it("refuses an unknown room and a room this caller may not read", async () => {
    const { room, deps } = fixture();
    const handler = createGroupRoutes({ ...deps, visibleFor: () => ({ group: () => false }) as never } as unknown as GroupRouteDeps);
    const sent: Array<{ status: number }> = [];
    const ctx = (roomId: string) => ({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/findings`),
      path: `/api/groups/${roomId}/findings`,
      method: "GET",
      auth: { kind: "session", scopes: ["client"] } as unknown as RequestAuth,
      json: ((_res: ServerResponse, status: number) => { sent.push({ status }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    await handler(ctx("nope"));
    await handler(ctx(room.id));
    expect(sent.map((row) => row.status)).toEqual([404, 403]);
  });

  it("declines another method so routing continues", async () => {
    const { room, call } = fixture();
    expect((await call(room.id, "POST")).out).toBe(PASS);
  });

  it("refuses a direct message, which holds no engagement findings", async () => {
    const { store, room, deps } = fixture();
    const dm = store.createGroup("Chat", [room.memberIds[0]!], true);
    const handler = createGroupRoutes(deps);
    const sent: Array<{ status: number }> = [];
    await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/groups/${dm.id}/findings`),
      path: `/api/groups/${dm.id}/findings`,
      method: "GET",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number) => { sent.push({ status }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    expect(sent.map((row) => row.status)).toEqual([400]);
  });
});
