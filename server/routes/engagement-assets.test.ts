import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngagementAssetsStore } from "../engagement-assets.ts";
import { createEngagementAssetInternalRoutes, ASSETS_PATH } from "./engagement-assets.ts";
import { PASS } from "./table.ts";

let dir: string;
let store: EngagementAssetsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "assets-route-"));
  store = new EngagementAssetsStore(join(dir, "engagement-assets.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(options: { room?: { id: string; memberIds: string[]; dm?: boolean } | null; body?: unknown } = {}) {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = {} as ServerResponse;
  const json = (_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body }); };
  const route = createEngagementAssetInternalRoutes({
    assets: store,
    roomOf: () => (options.room === null ? null : (options.room ?? { id: "eng-room", memberIds: ["bot-a"] })) as never,
  });
  const call = (path: string, method = "POST") => route({
    path, method, res, json: json as never, botId: "bot-a", threadId: "t1",
    readBody: async () => options.body,
  });
  return { sent, call };
}

describe("the engagement assets internal route", () => {
  it("passes on paths it does not own", async () => {
    const { call } = harness();
    expect(await call("/api/internal/threads")).toBe(PASS);
    expect(await call(ASSETS_PATH, "GET")).toBe(PASS);
  });

  it("refuses outside an engagement room", async () => {
    const { call, sent } = harness({ room: null, body: { action: "list" } });
    await call(ASSETS_PATH);
    expect(sent).toEqual([{ status: 409, body: { error: expect.stringContaining("engagement room") } }]);
  });

  it("refuses a direct message, which holds no assets", async () => {
    const { call, sent } = harness({ room: { id: "dm", memberIds: ["bot-a"], dm: true } as never, body: { action: "list" } });
    await call(ASSETS_PATH);
    expect(sent).toEqual([{ status: 409, body: { error: expect.stringContaining("direct message") } }]);
  });

  it("records, lists and updates in the caller's room", async () => {
    const record = harness({ body: { action: "record", location: "https://app.example.com", kind: "web-app", discoveredBy: "nmap -sV" } });
    await record.call(ASSETS_PATH);
    const created = (record.sent[0]!.body as { asset: { id: string; kind: string } }).asset;
    expect(record.sent[0]!.status).toBe(200);
    expect(created.kind).toBe("web-app");

    const list = harness({ body: { action: "list" } });
    await list.call(ASSETS_PATH);
    expect((list.sent[0]!.body as { assets: unknown[] }).assets).toHaveLength(1);

    const update = harness({ body: { action: "update", id: created.id, service: "nginx 1.26.0" } });
    await update.call(ASSETS_PATH);
    expect((update.sent[0]!.body as { asset: { service: string } }).asset.service).toBe("nginx 1.26.0");
  });

  it("rejects an unknown action and a body the store refuses", async () => {
    const bad = harness({ body: { action: "delete" } });
    await bad.call(ASSETS_PATH);
    expect(bad.sent[0]!.status).toBe(400);

    const missing = harness({ body: { action: "record", location: "app.example.com" } });
    await missing.call(ASSETS_PATH);
    expect(missing.sent[0]!.status).toBeGreaterThanOrEqual(400);
    expect(store.list("eng-room")).toHaveLength(0);
  });
});
