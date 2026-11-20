import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngagementRefusalsStore, refusalKey } from "./engagement.ts";
import { addHeldSecretScrubber } from "./redact.ts";

let directory: string;
let filename: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-refusals-"));
  filename = join(directory, "engagement-refusals.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const outside = { ok: false as const, reason: "targets" as const, hosts: ["evil.test"] };

describe("engagement refusals", () => {
  it("records a refusal with the host it reached for, and bumps the same command instead of repeating it", () => {
    const store = new EngagementRefusalsStore(filename);
    store.record("room-a", outside, "curl https://evil.test/");
    store.record("room-a", outside, "curl https://evil.test/");
    const [refusal] = store.list("room-a");
    expect(refusal).toMatchObject({ command: "curl https://evil.test/", reason: "targets", hosts: ["evil.test"], attempts: 2 });
  });

  it("keeps a window refusal apart from a target refusal of the same command, and keeps each room's refusals apart", () => {
    const store = new EngagementRefusalsStore(filename);
    store.record("room-a", outside, "curl https://evil.test/");
    store.record("room-a", { ok: false, reason: "window", detail: "ended" }, "curl https://evil.test/");
    store.record("room-b", outside, "curl https://evil.test/");
    expect(store.list("room-a")).toHaveLength(2);
    expect(store.list("room-a").map((refusal) => refusal.reason).sort()).toEqual(["targets", "window"]);
    expect(store.list("room-b")).toHaveLength(1);
  });

  it("carries which side of the window a window refusal was", () => {
    const store = new EngagementRefusalsStore(filename);
    store.record("room-a", { ok: false, reason: "window", detail: "not started" }, "nmap example.com");
    expect(store.list("room-a")[0]).toMatchObject({ reason: "window", window: "not started", hosts: [] });
  });

  it("drops the oldest refusals rather than wedging a room under sustained probing", () => {
    const store = new EngagementRefusalsStore(filename);
    for (let i = 0; i < 250; i += 1) store.record("room-a", outside, `curl https://evil.test/${i}`);
    const kept = store.list("room-a");
    expect(kept).toHaveLength(200);
    expect(kept.at(-1)!.command).toBe("curl https://evil.test/249");
    expect(kept.some((refusal) => refusal.command === "curl https://evil.test/0")).toBe(false);
  });

  it("round-trips through disk", () => {
    const store = new EngagementRefusalsStore(filename);
    store.record("room-a", outside, "curl https://evil.test/");
    expect(new EngagementRefusalsStore(filename).list("room-a")).toHaveLength(1);
  });

  it("never blocks a command: a damaged store reads nothing and records nothing", () => {
    writeFileSync(filename, "{not json");
    const store = new EngagementRefusalsStore(filename);
    expect(() => store.record("room-a", outside, "curl https://evil.test/")).not.toThrow();
    expect(store.list("room-a")).toEqual([]);
  });

  it("keys a refusal by its command text and reason", () => {
    expect(refusalKey({ command: "curl https://evil.test/", reason: "targets" }))
      .not.toBe(refusalKey({ command: "curl https://evil.test/", reason: "window" }));
  });

  it("masks a held secret in a command before writing it where a person reads it", () => {
    const remove = addHeldSecretScrubber((text) => text.replaceAll("fixture-token-9876", "••••••"));
    try {
      const store = new EngagementRefusalsStore(filename);
      store.record("room-a", outside, "curl -H 'Authorization: Bearer fixture-token-9876' https://evil.test/");
      expect(store.list("room-a")[0]!.command).not.toContain("fixture-token-9876");
    } finally {
      remove();
    }
  });
});
