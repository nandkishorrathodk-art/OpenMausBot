import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assetKey, EngagementAssetsStore, parseAsset } from "./engagement.ts";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-assets-"));
  filename = join(directory, "engagement-assets.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const asset = (over: Record<string, unknown> = {}) => ({
  location: "https://app.example.com", kind: "web-app", service: "nginx 1.25.3",
  discoveredBy: "nmap -sV 10.0.0.0/24", ...over,
});

describe("engagement assets", () => {
  it("requires a location and how it was found, and defaults the kind", () => {
    const parsed = parseAsset({ location: "app.example.com", discoveredBy: "nmap -sV" });
    expect(parsed).toEqual({ ok: true, asset: { location: "app.example.com", kind: "host", discoveredBy: "nmap -sV" } });
    for (const bad of [{}, { location: "x" }, { location: "x", discoveredBy: "" }, { discoveredBy: "nmap" }, null, 7]) {
      expect(parseAsset(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseAsset({ ...asset(), kind: "router" }).ok).toBe(false);
  });

  it("keeps an existing asset up to date when the same location comes back, ignoring case and a trailing slash", () => {
    const store = new EngagementAssetsStore(filename);
    const first = store.record("room-a", asset());
    const again = store.record("room-a", asset({ location: "https://app.example.com/", service: "nginx 1.26.0" }));
    expect(again.id).toBe(first.id);
    expect(again.service).toBe("nginx 1.26.0");
    expect(again.firstSeenAt).toBe(first.firstSeenAt);
    expect(store.list("room-a")).toHaveLength(1);
  });

  it("records, patches, lists and removes, keeping each room's assets apart", () => {
    const store = new EngagementAssetsStore(filename);
    const one = store.record("room-a", asset());
    store.record("room-b", asset({ location: "other.example.com" }));
    expect(store.list("room-a").map((a) => a.id)).toEqual([one.id]);
    expect(store.list("room-b")).toHaveLength(1);

    const patched = store.patch("room-a", one.id, { service: "nginx 1.26.0", notes: "staging" });
    expect(patched.service).toBe("nginx 1.26.0");
    expect(patched.notes).toBe("staging");
    expect(patched.location).toBe("https://app.example.com");

    expect(store.remove("room-a", one.id)).toBe(true);
    expect(store.remove("room-a", one.id)).toBe(false);
    expect(store.list("room-a")).toEqual([]);
    expect(store.list("room-b")).toHaveLength(1);
  });

  it("refuses a patch or a remove for an asset this room does not hold", () => {
    const store = new EngagementAssetsStore(filename);
    expect(() => store.patch("room-a", "nope", { service: "x" })).toThrow(/No such asset/);
    expect(store.remove("room-a", "nope")).toBe(false);
  });

  it("round-trips through disk", () => {
    const store = new EngagementAssetsStore(filename);
    const saved = store.record("room-a", asset({ banner: "HTTP/1.1 200 OK\nServer: nginx" }));
    const reopened = new EngagementAssetsStore(filename);
    expect(reopened.list("room-a")).toEqual([saved]);
  });

  it("fails closed on a damaged store: it reads nothing and refuses every change", () => {
    writeFileSync(filename, "{not json");
    const store = new EngagementAssetsStore(filename);
    expect(store.list("room-a")).toEqual([]);
    expect(() => store.record("room-a", asset())).toThrow(/could not be read/);
  });

  it("keys an asset by its location, ignoring case and a trailing slash", () => {
    expect(assetKey(" HTTPS://App.Example.com/ ")).toBe(assetKey("https://app.example.com"));
  });
});
