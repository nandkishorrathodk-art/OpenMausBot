import { describe, expect, it, vi } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools } from "./agents-catalog.ts";
import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { callEngagementFindingTool, ENGAGEMENT_FINDING_TOOL } from "./agents-finding-tool.ts";

const context = (answer: { ok: boolean; body: Record<string, unknown> }) =>
  ({ client: { apiResponse: vi.fn(async () => answer) }, botId: "bot-a", threadId: "t1" }) as unknown as ToolCallContext;

const finding = (over: Record<string, unknown> = {}) => ({
  id: "f-1", target: "app.example", title: "IDOR on invoices", severity: "high", status: "suspected",
  evidence: "GET /invoices/42 as another user returns their invoice", reportedAt: 1, updatedAt: 1, ...over,
});

describe("the engagement_finding tool", () => {
  it("is listed in a room's turn and in no other conversation", () => {
    const room = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot", OMB_ROOM: "1" })).map((tool) => tool.name);
    const direct = availableTools(catalogProfileFromEnv({ OMB_BOT_ID: "bot" })).map((tool) => tool.name);
    expect(room).toContain(ENGAGEMENT_FINDING_TOOL);
    expect(direct).not.toContain(ENGAGEMENT_FINDING_TOOL);
  });

  it("posts the action and fields to the internal findings route", async () => {
    const asked = context({ ok: true, body: { finding: finding() } });
    await callEngagementFindingTool({ action: "record", target: "app.example", title: "IDOR on invoices", severity: "high", evidence: "GET /invoices/42" }, asked);
    const [path, init] = (asked.client.apiResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(path).toBe("/api/internal/findings");
    expect(JSON.parse(init.body)).toEqual({ action: "record", target: "app.example", title: "IDOR on invoices", severity: "high", evidence: "GET /invoices/42" });
  });

  it("reads back a record and an update by their id, and names the ledger on an empty list", async () => {
    await expect(callEngagementFindingTool({ action: "record", target: "x", title: "y", evidence: "z" }, context({ ok: true, body: { finding: finding() } })))
      .resolves.toMatchObject({ text: expect.stringContaining("Recorded") });
    await expect(callEngagementFindingTool({ action: "update", id: "f-1", status: "proven" }, context({ ok: true, body: { finding: finding({ status: "proven" }) } })))
      .resolves.toMatchObject({ text: expect.stringContaining("Updated") });
    await expect(callEngagementFindingTool({ action: "list" }, context({ ok: true, body: { findings: [] } })))
      .resolves.toMatchObject({ text: expect.stringContaining("No findings recorded") });
  });

  it("lists worst first and hands a route refusal back as a tool error", async () => {
    const listed = await callEngagementFindingTool({ action: "list" }, context({ ok: true, body: { findings: [finding({ severity: "low" }), finding({ id: "f-2", severity: "critical", title: "RCE" })] } }));
    expect(listed.text.indexOf("critical")).toBeLessThan(listed.text.indexOf("low"));
    await expect(callEngagementFindingTool({ action: "list" }, context({ ok: false, body: { error: "Findings live in an engagement room." } })))
      .resolves.toEqual({ text: "Findings live in an engagement room.", isError: true });
  });

  it("forwards the proof and shows it back, so a proven claim carries its reproduction", async () => {
    const asked = context({ ok: true, body: { finding: finding({ status: "proven", proof: "curl -i https://app.example/invoices/42 -> 200 with another user's invoice" }) } });
    const result = await callEngagementFindingTool({ action: "update", id: "f-1", status: "proven", proof: "curl -i https://app.example/invoices/42 -> 200 with another user's invoice" }, asked);
    const [, init] = (asked.client.apiResponse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body)).toMatchObject({ proof: "curl -i https://app.example/invoices/42 -> 200 with another user's invoice" });
    expect(result.text).toContain("Proof: curl -i");
  });

  it("reaches the route when a bot calls it by name", async () => {
    const asked = context({ ok: true, body: { findings: [] } });
    await expect(callTool(ENGAGEMENT_FINDING_TOOL, { action: "list" }, asked)).resolves.toMatchObject({ text: expect.stringContaining("No findings recorded") });
    expect(asked.client.apiResponse).toHaveBeenCalledWith("/api/internal/findings", expect.objectContaining({ method: "POST" }));
  });
});
