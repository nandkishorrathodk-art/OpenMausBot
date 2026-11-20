import { describe, expect, it, vi } from "vitest";

import { parseProof, replayProof } from "./engagement-replay.ts";
import type { EngagementProof, EngagementScope } from "../shared/engagement.ts";

const scope: EngagementScope = { targets: ["api.example.com"], offLimits: [] };

function answer(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const proof = (over: Partial<EngagementProof> = {}): EngagementProof => ({
  kind: "http",
  method: "GET",
  url: "https://api.example.com/items/1",
  ...over,
});

describe("parseProof", () => {
  it("accepts one http request with an expectation", () => {
    const parsed = parseProof({ kind: "http", method: "post", url: "https://api.example.com/items", body: "{}", expect: "leaked" });
    expect(parsed).toEqual({
      ok: true,
      proof: { kind: "http", method: "POST", url: "https://api.example.com/items", body: "{}", expect: "leaked" },
    });
  });

  it("defaults the method to GET", () => {
    const parsed = parseProof({ url: "https://api.example.com/" });
    expect(parsed.ok && parsed.proof.method).toBe("GET");
  });

  it("refuses a proof a server cannot replay", () => {
    expect(parseProof({ kind: "command", command: "curl -s https://api.example.com" })).toEqual({
      ok: false,
      error: "Only an http proof can be replayed: one request the target answers. Record a command's output as proof text.",
    });
  });

  it("refuses a relative or non-http url", () => {
    expect(parseProof({ url: "/items/1" }).ok).toBe(false);
    expect(parseProof({ url: "file:///etc/passwd" }).ok).toBe(false);
  });

  it("refuses the headers the replay sets itself", () => {
    const parsed = parseProof({ url: "https://api.example.com/", headers: { Host: "elsewhere.test" } });
    expect(parsed).toEqual({ ok: false, error: "The replay sets Host itself." });
  });

  it("refuses a header that would split the request", () => {
    const parsed = parseProof({ url: "https://api.example.com/", headers: { "X-Trace": "one\r\nHost: elsewhere.test" } });
    expect(parsed.ok).toBe(false);
  });

  it("refuses an unknown method", () => {
    expect(parseProof({ url: "https://api.example.com/", method: "TRACE" }).ok).toBe(false);
  });
});

describe("replayProof", () => {
  it("holds when the expected text comes back", async () => {
    const fetchImpl = vi.fn(answer("<html>admin=1</html>"));
    const result = await replayProof(proof({ expect: "admin=1" }), scope, { fetch: fetchImpl, now: () => 1_700_000_000_000 });
    expect(result).toEqual({ at: 1_700_000_000_000, ok: true, excerpt: "<html>admin=1</html>" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/items/1", expect.objectContaining({ method: "GET" }));
  });

  it("fails when the target answers but the flaw is gone", async () => {
    const result = await replayProof(proof({ expect: "admin=1" }), scope, { fetch: answer("not found", 404) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("the expected text is gone");
    expect(result.excerpt).toBe("not found");
  });

  it("records the answer when the proof expects nothing", async () => {
    const result = await replayProof(proof(), scope, { fetch: answer("ok", 500) });
    expect(result).toEqual({ at: expect.any(Number), ok: true, excerpt: "HTTP 500 ok" });
  });

  it("never leaves the scope the client signed", async () => {
    const fetchImpl = vi.fn(answer(""));
    const result = await replayProof(proof({ url: "https://evil.test/items/1" }), scope, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("evil.test is outside this engagement's authorized scope.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a replay when the room has no scope", async () => {
    const fetchImpl = vi.fn(answer(""));
    const result = await replayProof(proof(), null, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no engagement scope");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honours off-limits above an authorized target", async () => {
    const fetchImpl = vi.fn(answer(""));
    const result = await replayProof(proof(), { targets: ["*.example.com"], offLimits: ["api.example.com"] }, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a target that never answered", async () => {
    const fetchImpl = (async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }); }) as unknown as typeof fetch;
    const result = await replayProof(proof(), scope, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The target could not be reached: connect ECONNREFUSED.");
  });

  it("reports a target that ran out of time", async () => {
    const fetchImpl = (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as unknown as typeof fetch;
    const result = await replayProof(proof(), scope, { fetch: fetchImpl, timeoutMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The target did not answer within 2s.");
  });

  it("sends no body on a GET", async () => {
    const fetchImpl = vi.fn(answer("ok"));
    await replayProof(proof({ method: "GET", body: "ignored" }), scope, { fetch: fetchImpl });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });

  it("sends the body on a POST", async () => {
    const fetchImpl = vi.fn(answer("ok"));
    await replayProof(proof({ method: "POST", body: "{\"id\":1}" }), scope, { fetch: fetchImpl });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).body).toBe("{\"id\":1}");
  });
});
