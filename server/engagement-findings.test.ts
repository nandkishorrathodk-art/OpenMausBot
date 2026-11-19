import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngagementFindingsStore, findingKey, parseFinding } from "./engagement-findings.ts";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-findings-"));
  filename = join(directory, "engagement-findings.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const finding = (over: Record<string, unknown> = {}) => ({
  target: "api.example.com", title: "Reflected XSS in q", severity: "high", status: "proven",
  evidence: "GET /search?q=<svg/onload=alert(1)> returned it unescaped",
  proof: "GET /search?q=%3Csvg%2Fonload%3Dalert(1)%3E -> 200 with the payload unescaped in the body",
  ...over,
});

describe("engagement findings", () => {
  it("requires a target, a title and evidence, and defaults severity and status", () => {
    const parsed = parseFinding({ target: "api.example.com", title: "Reflected XSS", evidence: "the response echoes the payload" });
    expect(parsed).toEqual({ ok: true, finding: { target: "api.example.com", title: "Reflected XSS", severity: "medium", status: "suspected", evidence: "the response echoes the payload" } });
    for (const bad of [{}, { target: "x" }, { target: "x", title: "y" }, { target: "x", title: "y", evidence: "" }, null, 7]) {
      expect(parseFinding(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseFinding({ ...finding(), severity: "urgent" }).ok).toBe(false);
    expect(parseFinding({ ...finding(), status: "maybe" }).ok).toBe(false);
  });

  it("keeps an existing finding up to date when the same target and title come back, ignoring case", () => {
    const store = new EngagementFindingsStore(filename);
    const first = store.record("room-a", finding({ status: "suspected", proof: undefined }));
    const again = store.record("room-a", finding({ title: "reflected xss in Q", status: "proven", evidence: "reproduced on staging" }));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("proven");
    expect(again.reportedAt).toBe(first.reportedAt);
    expect(store.list("room-a")).toHaveLength(1);
  });

  it("refuses the proven label without a reproduction a person can run again", () => {
    expect(parseFinding({ target: "x", title: "y", evidence: "looks exploitable", status: "proven" }).ok).toBe(false);
    expect(parseFinding({ target: "x", title: "y", evidence: "looks exploitable", status: "proven", proof: "   " }).ok).toBe(false);
    expect(parseFinding({ target: "x", title: "y", evidence: "looks exploitable", status: "proven", proof: "curl -i https://x/?q=1 -> 200" }).ok).toBe(true);

    const store = new EngagementFindingsStore(filename);
    expect(() => store.record("room-a", finding({ proof: undefined }))).toThrow(/proven only with proof/);
    expect(store.list("room-a")).toEqual([]);
    expect(() => store.patch("room-a", "missing", { status: "proven" })).toThrow(/No such finding/);
  });

  it("keeps proof out of the record when it is not given, so a suspected finding carries none", () => {
    const parsed = parseFinding({ target: "x", title: "y", evidence: "seen once" });
    expect(parsed.ok && "proof" in parsed.finding).toBe(false);
  });

  it("records, patches, lists and removes, keeping each room's findings apart", () => {
    const store = new EngagementFindingsStore(filename);
    const one = store.record("room-a", finding());
    store.record("room-b", finding({ target: "other.example.com" }));
    expect(store.list("room-a").map((f) => f.id)).toEqual([one.id]);
    expect(store.list("room-b")).toHaveLength(1);

    const patched = store.patch("room-a", one.id, { status: "fixed", detail: "patched in v2.1" });
    expect(patched.status).toBe("fixed");
    expect(patched.detail).toBe("patched in v2.1");
    expect(patched.title).toBe("Reflected XSS in q");

    expect(store.remove("room-a", one.id)).toBe(true);
    expect(store.remove("room-a", one.id)).toBe(false);
    expect(store.list("room-a")).toEqual([]);
    expect(store.list("room-b")).toHaveLength(1);
  });

  it("refuses a patch or a remove for a finding this room does not hold", () => {
    const store = new EngagementFindingsStore(filename);
    expect(() => store.patch("room-a", "nope", { status: "fixed" })).toThrow(/No such finding/);
    expect(store.remove("room-a", "nope")).toBe(false);
  });

  it("round-trips through disk", () => {
    const store = new EngagementFindingsStore(filename);
    const saved = store.record("room-a", finding({ detail: "steps: open /search, submit the payload" }));
    const reopened = new EngagementFindingsStore(filename);
    expect(reopened.list("room-a")).toEqual([saved]);
  });

  it("fails closed on a damaged store: it reads nothing and refuses every change", () => {
    writeFileSync(filename, "{not json");
    const store = new EngagementFindingsStore(filename);
    expect(store.list("room-a")).toEqual([]);
    expect(() => store.record("room-a", finding())).toThrow(/could not be read/);
  });

  it("keys a finding by its target and title, ignoring case and space", () => {
    expect(findingKey(" API.example.com ", "Reflected XSS")).toBe(findingKey("api.example.com", "reflected xss"));
  });

  it("reads a store written before proof was required, demoting a proven finding that has none", () => {
    writeFileSync(filename, JSON.stringify({ version: 1, rooms: [{ roomId: "room-a", findings: [
      { id: "f-1", target: "x", title: "unproven claim", severity: "high", status: "proven",
        evidence: "someone said it works", reportedAt: 1, updatedAt: 1 },
      { id: "f-2", target: "y", title: "real one", severity: "high", status: "proven",
        evidence: "reproduced", proof: "curl -i https://y/?q=1 -> 200", reportedAt: 2, updatedAt: 2 },
    ] }] }));
    const store = new EngagementFindingsStore(filename);
    const listed = store.list("room-a");
    expect(listed.map((f) => [f.id, f.status])).toEqual([["f-1", "suspected"], ["f-2", "proven"]]);
    expect(listed[0]!.evidence).toBe("someone said it works");
    expect(() => store.record("room-a", finding())).not.toThrow();
  });
});
