import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngagementFindingsStore } from "../engagement.ts";
import { createEngagementFindingInternalRoutes, FINDINGS_PATH } from "./engagement-findings.ts";
import { PASS } from "./table.ts";

let dir: string;
let store: EngagementFindingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "findings-route-"));
  store = new EngagementFindingsStore(join(dir, "engagement-findings.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(options: { room?: { id: string; memberIds: string[]; dm?: boolean } | null; body?: unknown } = {}) {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = {} as ServerResponse;
  const json = (_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body }); };
  const route = createEngagementFindingInternalRoutes({
    findings: store,
    roomOf: () => (options.room === null ? null : (options.room ?? { id: "eng-room", memberIds: ["bot-a"] })) as never,
  });
  const call = (path: string, method = "POST") => route({
    path, method, res, json: json as never, botId: "bot-a", threadId: "t1",
    readBody: async () => options.body,
  });
  return { sent, call };
}

describe("the engagement findings internal route", () => {
  it("passes on paths it does not own", async () => {
    const { call } = harness();
    expect(await call("/api/internal/threads")).toBe(PASS);
    expect(await call(FINDINGS_PATH, "GET")).toBe(PASS);
  });

  it("refuses outside an engagement room", async () => {
    const { call, sent } = harness({ room: null, body: { action: "list" } });
    await call(FINDINGS_PATH);
    expect(sent).toEqual([{ status: 409, body: { error: expect.stringContaining("engagement room") } }]);
  });

  it("refuses a direct message, which holds no findings", async () => {
    const { call, sent } = harness({ room: { id: "dm", memberIds: ["bot-a"], dm: true } as never, body: { action: "list" } });
    await call(FINDINGS_PATH);
    expect(sent).toEqual([{ status: 409, body: { error: expect.stringContaining("direct message") } }]);
  });

  it("records, lists and updates in the caller's room", async () => {
    const record = harness({ body: { action: "record", target: "app.example", title: "IDOR", evidence: "GET /invoices/42 as another user returns their invoice" } });
    await record.call(FINDINGS_PATH);
    const created = (record.sent[0]!.body as { finding: { id: string; severity: string; status: string } }).finding;
    expect(record.sent[0]!.status).toBe(200);
    expect(created.severity).toBe("medium");
    expect(created.status).toBe("suspected");

    const list = harness({ body: { action: "list" } });
    await list.call(FINDINGS_PATH);
    expect((list.sent[0]!.body as { findings: unknown[] }).findings).toHaveLength(1);

    const update = harness({ body: { action: "update", id: created.id, status: "proven" } });
    await update.call(FINDINGS_PATH);
    expect(update.sent[0]!.status).toBe(400);
    expect((update.sent[0]!.body as { error: string }).error).toContain("proven only with proof");

    const proven = harness({ body: { action: "update", id: created.id, status: "proven", proof: "curl -i https://app.example/invoices/42 -> 200 with another user's invoice" } });
    await proven.call(FINDINGS_PATH);
    expect(proven.sent[0]!.status).toBe(200);
    expect((proven.sent[0]!.body as { finding: { status: string } }).finding.status).toBe("proven");
  });

  it("rejects an unknown action and a body the store refuses", async () => {
    const bad = harness({ body: { action: "delete" } });
    await bad.call(FINDINGS_PATH);
    expect(bad.sent[0]!.status).toBe(400);

    const missing = harness({ body: { action: "record", target: "x", title: "y" } });
    await missing.call(FINDINGS_PATH);
    expect(missing.sent[0]!.status).toBeGreaterThanOrEqual(400);
    expect(store.list("eng-room")).toHaveLength(0);
  });
});
