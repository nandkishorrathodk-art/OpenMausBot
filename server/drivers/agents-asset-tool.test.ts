import { describe, expect, it, vi } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { callEngagementAssetTool, ENGAGEMENT_ASSET_TOOL } from "./agents-asset-tool.ts";

const context = (answer: { ok: boolean; body: Record<string, unknown> }) =>
  ({ client: { apiResponse: vi.fn(async () => answer) }, botId: "bot-a", threadId: "t1" }) as unknown as ToolCallContext;

const asset = (over: Record<string, unknown> = {}) => ({
  id: "a-1", location: "https://app.example.com", kind: "web-app", service: "nginx 1.25.3",
  discoveredBy: "nmap -sV 10.0.0.0/24", firstSeenAt: 1, lastSeenAt: 1, ...over,
});

describe("the engagement_asset tool", () => {
  it("is listed in a room's turn and in no other conversation", () => {
    const room = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot", OMB_ROOM: "1" })).map((tool) => tool.name);
    const direct = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot" })).map((tool) => tool.name);
    expect(room).toContain(ENGAGEMENT_ASSET_TOOL);
    expect(direct).not.toContain(ENGAGEMENT_ASSET_TOOL);
  });

  it("posts the action and fields to the internal assets route", async () => {
    const asked = context({ ok: true, body: { asset: asset() } });
    await callEngagementAssetTool({ action: "record", location: "https://app.example.com", kind: "web-app", service: "nginx 1.25.3", discoveredBy: "nmap -sV" }, asked);
    const [path, init] = (asked.client.apiResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(path).toBe("/api/internal/assets");
    expect(JSON.parse(init.body)).toEqual({ action: "record", location: "https://app.example.com", kind: "web-app", service: "nginx 1.25.3", discoveredBy: "nmap -sV" });
  });

  it("reads back a record and an update by their id, and names the inventory on an empty list", async () => {
    await expect(callEngagementAssetTool({ action: "record", location: "x", discoveredBy: "nmap" }, context({ ok: true, body: { asset: asset() } })))
      .resolves.toMatchObject({ text: expect.stringContaining("Recorded") });
    await expect(callEngagementAssetTool({ action: "update", id: "a-1", service: "nginx 1.26.0" }, context({ ok: true, body: { asset: asset({ service: "nginx 1.26.0" }) } })))
      .resolves.toMatchObject({ text: expect.stringContaining("Updated") });
    await expect(callEngagementAssetTool({ action: "list" }, context({ ok: true, body: { assets: [] } })))
      .resolves.toMatchObject({ text: expect.stringContaining("No assets recorded") });
  });

  it("lists the inventory and dispatches through the catalog's call path", async () => {
    const asked = context({ ok: true, body: { assets: [asset()] } });
    await expect(callEngagementAssetTool({ action: "list" }, asked)).resolves.toMatchObject({ text: expect.stringContaining("https://app.example.com") });
    await callTool(ENGAGEMENT_ASSET_TOOL, { action: "list" }, asked);
    expect((asked.client.apiResponse as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/api/internal/assets");
  });
});
