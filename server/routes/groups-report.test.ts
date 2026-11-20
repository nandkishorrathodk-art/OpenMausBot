import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireGroup } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import { EngagementFindingsStore, EngagementScopeStore, EngagementRefusalsStore } from "../engagement.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createGroupRoutes, type GroupRouteDeps } from "./groups.ts";
import { PASS, type RouteContext } from "./table.ts";

const sonnet = { instanceId: "claude", model: "claude-sonnet-5" } as never;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const room = store.createGroup("Acme Q4 engagement", [bot.id]);
  const findings = new EngagementFindingsStore(`${DATA_DIR}/engagement-findings.json`);
  findings.record(room.id, {
    target: "api.acme.test", title: "IDOR on invoices", severity: "critical", status: "proven",
    evidence: "GET /invoices/42 as another user returns their invoice",
    proof: "GET /invoices/42 with the other user's session -> 200 with their invoice body",
  });
  const scope = new EngagementScopeStore(`${DATA_DIR}/engagement-scopes.json`);
  scope.set(room.id, { targets: ["acme.test", "*.acme.test"], offLimits: [] });
  const deps = {
    store, cloudHome: false,
    visibleFor: () => ({ group: () => true }) as never,
    actorKey: () => "person",
    threadStarters: { set: () => {} },
    createChannel: () => room,
    publicGroupState: (g: { id: string }) => g as unknown as WireGroup,
    scope,
    canManageScope: () => true,
    findings,
    refusals: new EngagementRefusalsStore(`${DATA_DIR}/engagement-refusals.json`),
  } as unknown as GroupRouteDeps;
  const handler = createGroupRoutes(deps);
  /** The report route writes the file itself, so it needs a real `writeHead`/`end`, not just `json`. */
  const call = async (roomId: string, method = "GET", auth: RequestAuth = { kind: "loopback", scopes: ["admin"] } as RequestAuth) => {
    let status = 0; let text = ""; const headers: Record<string, string> = {};
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: { writeHead(code: number, h?: Record<string, string>) { status = code; Object.assign(headers, h); }, end(data?: string) { text = data ?? ""; } } as unknown as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/report`),
      path: `/api/groups/${roomId}/report`,
      method, auth,
      json: ((_res: ServerResponse, code: number, body: unknown) => { status = code; text = JSON.stringify(body); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    return { out, status, text, headers };
  };
  return { store, room, findings, scope, deps, call };
}

describe("GET /api/groups/:id/report", () => {
  it("hands the room's scope and findings over as a markdown file", async () => {
    const { room, call } = fixture();
    const answer = await call(room.id);
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(answer.headers["content-disposition"]).toBe('attachment; filename="acme-q4-engagement-report-' + new Date().toISOString().slice(0, 10) + '.md"');
    expect(answer.text).toContain("# Engagement report — Acme Q4 engagement");
    expect(answer.text).toContain("Authorized targets: acme.test, *.acme.test");
    expect(answer.text).toContain("| Critical | Proven | api.acme.test | IDOR on invoices |");
    expect(answer.text).toContain("GET /invoices/42 as another user returns their invoice");
  });

  it("still reports the scope when nothing was found", async () => {
    const { store, room, deps, call } = fixture();
    const empty = store.createGroup("Empty room", [room.memberIds[0]!]);
    deps.scope.set(empty.id, { targets: ["quiet.test"], offLimits: [] });
    const answer = await call(empty.id);
    expect(answer.text).toContain("No findings were recorded under this scope.");
    expect(answer.text).toContain("Authorized targets: quiet.test");
  });

  it("refuses an unknown room and a room this caller may not read", async () => {
    const { room, deps } = fixture();
    const handler = createGroupRoutes({ ...deps, visibleFor: () => ({ group: () => false }) as never } as unknown as GroupRouteDeps);
    const statuses: number[] = [];
    const at = (roomId: string) => handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: { writeHead(code: number) { statuses.push(code); }, end() {} } as unknown as ServerResponse,
      url: new URL(`http://localhost/api/groups/${roomId}/report`),
      path: `/api/groups/${roomId}/report`, method: "GET",
      auth: { kind: "session", scopes: ["client"] } as unknown as RequestAuth,
      json: ((_res: ServerResponse, code: number) => { statuses.push(code); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    await at("nope");
    await at(room.id);
    expect(statuses).toEqual([404, 403]);
  });

  it("refuses a direct message, which holds no engagement report", async () => {
    const { store, room, call } = fixture();
    const dm = store.createGroup("Chat", [room.memberIds[0]!], true);
    expect((await call(dm.id)).status).toBe(400);
  });

  it("declines another method so routing continues", async () => {
    const { room, call } = fixture();
    expect((await call(room.id, "POST")).out).toBe(PASS);
  });
});
