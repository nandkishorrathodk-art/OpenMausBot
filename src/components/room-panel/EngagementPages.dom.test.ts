// @vitest-environment happy-dom
// The engagement pages the Room panel opens: the scope form's save and clear, the assets inventory and the findings
// list's order and rows.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  readScope: vi.fn(),
  saveScope: vi.fn(),
  readFindings: vi.fn(),
  readAssets: vi.fn(),
  readRefusals: vi.fn(),
  downloadReport: vi.fn(),
  ownerOrAdmin: true as boolean | null,
}));

vi.mock("@/lib/engagement", () => ({
  readRoomScope: fixture.readScope,
  saveRoomScope: fixture.saveScope,
  readRoomFindings: fixture.readFindings,
  readRoomAssets: fixture.readAssets,
  readRoomRefusals: fixture.readRefusals,
  downloadRoomReport: fixture.downloadReport,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));

const { EngagementScopePage } = await import("./EngagementScopePage");
const { EngagementFindingsPage } = await import("./EngagementFindingsPage");
const { EngagementAssetsPage } = await import("./EngagementAssetsPage");
const { EngagementRefusalsPage } = await import("./EngagementRefusalsPage");

const group = { id: "desk", name: "Desk HQ" } as unknown as Group;

let host: HTMLDivElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};

beforeEach(() => {
  fixture.ownerOrAdmin = true;
  fixture.readScope.mockReset();
  fixture.saveScope.mockReset();
  fixture.readFindings.mockReset();
  fixture.readAssets.mockReset();
  fixture.readRefusals.mockReset();
  fixture.downloadReport.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("the engagement scope page", () => {
  it("fills the form from the room's scope and saves what the person typed, one target per line", async () => {
    fixture.readScope.mockResolvedValue({ targets: ["example.com"], offLimits: ["admin.example.com"] });
    fixture.saveScope.mockResolvedValue({ targets: ["example.com", "api.example.com"], offLimits: [] });
    flushSync(() => root.render(createElement(EngagementScopePage, { group })));
    await settle();
    const targets = $<HTMLTextAreaElement>('[data-panel-row="scope-targets"] textarea')!;
    const offLimits = $<HTMLTextAreaElement>('[data-panel-row="scope-off-limits"] textarea')!;
    expect(targets.value).toBe("example.com");
    expect(offLimits.value).toBe("admin.example.com");
    type(targets, "example.com\napi.example.com");
    click($('[data-panel-row="scope-actions"] button:last-child'));
    await settle();
    expect(fixture.saveScope.mock.calls[0]![0]).toBe("desk");
    expect(fixture.saveScope.mock.calls[0]![1]).toMatchObject({ targets: ["example.com", "api.example.com"], offLimits: ["admin.example.com"] });
  });

  it("clears the scope with the Clear button", async () => {
    fixture.readScope.mockResolvedValue({ targets: ["example.com"], offLimits: [] });
    fixture.saveScope.mockResolvedValue(null);
    flushSync(() => root.render(createElement(EngagementScopePage, { group })));
    await settle();
    const clear = [...document.querySelectorAll('[data-panel-row="scope-actions"] button')].find((button) => button.textContent === "Clear scope")!;
    click(clear);
    await settle();
    expect(fixture.saveScope.mock.calls[0]![1]).toBeNull();
  });

  it("tells a member the scope is the owner's to set", async () => {
    fixture.ownerOrAdmin = false;
    flushSync(() => root.render(createElement(EngagementScopePage, { group })));
    await settle();
    expect(document.body.textContent).toContain("Only the owner or an admin");
    expect(fixture.readScope).not.toHaveBeenCalled();
  });
});

describe("the engagement findings page", () => {
  it("lists the worst finding first with its severity, status and evidence", async () => {
    fixture.readFindings.mockResolvedValue([
      { id: "1", target: "a.example.com", title: "Weak TLS", severity: "low", status: "suspected", evidence: "nmap", reportedAt: 1, updatedAt: 1 },
      { id: "2", target: "b.example.com", title: "Open redirect", severity: "critical", status: "proven", evidence: "curl -I", proof: "curl -I https://b.example.com/?next=evil.test -> 302 to evil.test", reportedAt: 2, updatedAt: 2 },
    ]);
    flushSync(() => root.render(createElement(EngagementFindingsPage, { group })));
    await settle();
    const rows = [...document.querySelectorAll("[data-finding]")];
    expect(rows.map((row) => row.getAttribute("data-finding"))).toEqual(["2", "1"]);
    expect(rows[0]!.textContent).toContain("Open redirect");
    expect(rows[0]!.textContent).toContain("Critical");
    expect(rows[0]!.textContent).toContain("Proven");
    expect(rows[0]!.textContent).toContain("curl -I");
    expect(rows[0]!.textContent).toContain("302 to evil.test");
  });

  it("shows the request a replay runs and what the last replay found", async () => {
    const repro = { kind: "http", method: "GET", url: "https://b.example.com/items/1", expect: "admin=1" };
    fixture.readFindings.mockResolvedValue([
      { id: "3", target: "b.example.com", title: "Broken access control", severity: "high", status: "proven",
        evidence: "another tenant's record came back", repro, replay: { at: 5, ok: true, excerpt: "admin=1" }, reportedAt: 3, updatedAt: 5 },
      { id: "4", target: "c.example.com", title: "Stale claim", severity: "medium", status: "suspected",
        evidence: "a request", repro, reportedAt: 4, updatedAt: 4 },
    ]);
    flushSync(() => root.render(createElement(EngagementFindingsPage, { group })));
    await settle();
    const rows = [...document.querySelectorAll("[data-finding]")];
    const proven = rows.find((row) => row.getAttribute("data-finding") === "3")!;
    expect(proven.textContent).toContain("GET https://b.example.com/items/1");
    expect(proven.textContent).toContain("the flaw reproduced again");
    const pending = rows.find((row) => row.getAttribute("data-finding") === "4")!;
    expect(pending.textContent).toContain("Not replayed yet");
  });

  it("says there are none yet when the ledger is empty", async () => {
    fixture.readFindings.mockResolvedValue([]);
    flushSync(() => root.render(createElement(EngagementFindingsPage, { group })));
    await settle();
    expect(document.body.textContent).toContain("The team records each flaw here");
  });

  it("saves the room's report from the button, and offers it even with nothing found", async () => {
    fixture.readFindings.mockResolvedValue([]);
    fixture.downloadReport.mockResolvedValue(undefined);
    flushSync(() => root.render(createElement(EngagementFindingsPage, { group })));
    await settle();
    click($("[data-panel-row='report-download']"));
    await settle();
    expect(fixture.downloadReport).toHaveBeenCalledWith(group.id, group.name);
  });

  it("says the report could not be saved when the download is refused", async () => {
    fixture.readFindings.mockResolvedValue([]);
    fixture.downloadReport.mockRejectedValue(new Error("nope"));
    flushSync(() => root.render(createElement(EngagementFindingsPage, { group })));
    await settle();
    click($("[data-panel-row='report-download']"));
    await settle();
    expect($("[data-panel-row='report-error']")?.textContent).toContain("nope");
  });
});

describe("the engagement refusals page", () => {
  it("lists the most recent refusal first with its command and the host it reached for", async () => {
    fixture.readRefusals.mockResolvedValue([
      { id: "1", command: "curl https://evil.test/", reason: "targets", hosts: ["evil.test"], attempts: 1, at: 1 },
      { id: "2", command: "nmap example.com", reason: "window", hosts: [], window: "ended", attempts: 1, at: 2 },
    ]);
    flushSync(() => root.render(createElement(EngagementRefusalsPage, { group })));
    await settle();
    const rows = [...document.querySelectorAll("[data-refusal]")];
    expect(rows.map((row) => row.getAttribute("data-refusal"))).toEqual(["2", "1"]);
    expect(rows[1]!.textContent).toContain("curl https://evil.test/");
    expect(rows[1]!.textContent).toContain("evil.test");
    expect(rows[0]!.textContent).toContain("after the authorization window closed");
  });

  it("says how often a repeated command was refused", async () => {
    fixture.readRefusals.mockResolvedValue([
      { id: "1", command: "curl https://evil.test/", reason: "targets", hosts: ["evil.test"], attempts: 3, at: 1 },
    ]);
    flushSync(() => root.render(createElement(EngagementRefusalsPage, { group })));
    await settle();
    expect(document.body.textContent).toContain("Refused 3 times");
  });

  it("says nothing was refused when the ledger is empty", async () => {
    fixture.readRefusals.mockResolvedValue([]);
    flushSync(() => root.render(createElement(EngagementRefusalsPage, { group })));
    await settle();
    expect(document.body.textContent).toContain("Every command the team ran stayed inside the authorized scope.");
  });
});

describe("the engagement assets page", () => {
  it("lists the inventory, flags an asset outside the scope and shows how each was found", async () => {
    fixture.readAssets.mockResolvedValue([
      { id: "1", location: "https://app.example.com", kind: "web-app", service: "nginx 1.25.3", discoveredBy: "nmap -sV", firstSeenAt: 1, lastSeenAt: 1, inScope: true },
      { id: "2", location: "https://elsewhere.test", kind: "host", discoveredBy: "nmap -sV", firstSeenAt: 2, lastSeenAt: 2, inScope: false },
    ]);
    flushSync(() => root.render(createElement(EngagementAssetsPage, { group })));
    await settle();
    const rows = [...document.querySelectorAll("[data-asset]")];
    expect(rows.map((row) => row.getAttribute("data-asset"))).toEqual(["1", "2"]);
    expect(rows[0]!.textContent).toContain("https://app.example.com");
    expect(rows[0]!.textContent).toContain("nginx 1.25.3");
    expect(rows[0]!.textContent).toContain("nmap -sV");
    expect(rows[0]!.textContent).not.toContain("Out of scope");
    expect(rows[1]!.textContent).toContain("Out of scope");
  });

  it("says there are none yet when the inventory is empty", async () => {
    fixture.readAssets.mockResolvedValue([]);
    flushSync(() => root.render(createElement(EngagementAssetsPage, { group })));
    await settle();
    expect(document.body.textContent).toContain("The team records each host, service or endpoint");
  });

  it("says the inventory could not be read when the request fails", async () => {
    fixture.readAssets.mockRejectedValue(new Error("nope"));
    flushSync(() => root.render(createElement(EngagementAssetsPage, { group })));
    await settle();
    expect($("[data-panel-row='assets-error']")?.textContent).toContain("nope");
  });
});
