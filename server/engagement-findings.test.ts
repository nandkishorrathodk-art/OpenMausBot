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
  evidence: "GET /search?q=<svg/onload=alert(1)> returned it unescaped", ...over,
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
    const first = store.record("room-a", finding({ status: "suspected" }));
    const again = store.record("room-a", finding({ title: "reflected xss in Q", status: "proven", evidence: "reproduced on staging" }));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("proven");
    expect(again.reportedAt).toBe(first.reportedAt);
    expect(store.list("room-a")).toHaveLength(1);
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
});
