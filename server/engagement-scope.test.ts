import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkCommand,
  createCommandScope,
  commandDestinations,
  type EngagementScope,
  EngagementScopeStore,
  hostInScope,
  normalizeScopeTarget,
  parseEngagementScope,
  scopeActive,
  scopeRefusalText,
} from "./engagement-scope.ts";

let directory: string;
let filename: string;
const stored = { targets: ["Example.com", "*.acme.test"], offLimits: ["admin.acme.test"] };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-engagement-scopes-"));
  filename = join(directory, "engagement-scopes.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("engagement scope store", () => {
  it("persists a normalized scope privately and returns a detached copy", () => {
    const store = new EngagementScopeStore(filename);
    expect(store.get("room-a")).toBeNull();
    const saved = store.set("room-a", stored);
    expect(saved?.targets).toEqual(["example.com", "*.acme.test"]);
    const read = store.get("room-a")!;
    read.targets.push("evil.test");
    read.offLimits.length = 0;
    const restarted = new EngagementScopeStore(filename);
    expect(restarted.get("room-a")).toEqual({ targets: ["example.com", "*.acme.test"], offLimits: ["admin.acme.test"] });
    if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
  });

  it("clears with null and reports whether a scope was there", () => {
    const store = new EngagementScopeStore(filename);
    store.set("room-a", stored);
    expect(store.set("room-a", null)).toBeNull();
    expect(store.get("room-a")).toBeNull();
    expect(store.clear("room-a")).toBe(false);
    store.set("room-a", stored);
    expect(store.clear("room-a")).toBe(true);
  });

  it("refuses a scope with no authorized target rather than refusing every command", () => {
    const store = new EngagementScopeStore(filename);
    expect(() => store.set("room-a", { targets: [] })).toThrow(/at least one authorized target/);
    expect(() => store.set("room-a", { targets: ["not a host"] })).toThrow();
    expect(() => store.set("room-a", { targets: ["a.com"], endsAt: 5, startsAt: 9 })).toThrow();
    expect(store.get("room-a")).toBeNull();
  });

  it("keeps one room's scope from another and survives a restart", () => {
    const store = new EngagementScopeStore(filename);
    store.set("room-a", { targets: ["a.com"] });
    store.set("room-b", { targets: ["b.com"] });
    const restarted = new EngagementScopeStore(filename);
    expect(restarted.get("room-a")?.targets).toEqual(["a.com"]);
    expect(restarted.get("room-b")?.targets).toEqual(["b.com"]);
  });

  it("fails closed on a damaged store: nothing is granted and nothing overwrites it", () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(filename, JSON.stringify({ version: 1, scopes: [{ roomId: "room-a", scope: { targets: ["a.com"], junk: true } }] }));
    const before = readFileSync(filename, "utf8");
    const store = new EngagementScopeStore(filename);
    expect(store.get("room-a")).toBeNull();
    expect(() => store.set("room-a", { targets: ["a.com"] })).toThrow(/could not be read/);
    expect(readFileSync(filename, "utf8")).toBe(before);
  });
});

const scope = (targets: string[], offLimits: string[] = [], window: { startsAt?: number; endsAt?: number } = {}): EngagementScope => ({ targets, offLimits, ...window });

describe("engagement scope targets", () => {
  it("normalizes a host, a wildcard, an address and a CIDR block, and rejects what is none of them", () => {
    expect(normalizeScopeTarget("Example.COM")).toBe("example.com");
    expect(normalizeScopeTarget("*.Example.com")).toBe("*.example.com");
    expect(normalizeScopeTarget("10.0.0.7")).toBe("10.0.0.7");
    expect(normalizeScopeTarget("10.0.0.7/24")).toBe("10.0.0.0/24");
    expect(normalizeScopeTarget("::1")).toBe("::1");
    for (const bad of ["", "localhost", "single", "not a host", "10.0.0.256", "10.0.0.0/33", "*.", "*.com", "1.2.3.4/8/9", null, 7]) {
      expect(normalizeScopeTarget(bad), String(bad)).toBeNull();
    }
  });

  it("requires at least one authorized target, so an empty scope never refuses everything", () => {
    expect(parseEngagementScope({ targets: [] })).toEqual({ ok: false, error: "An engagement scope needs at least one authorized target. Send null to clear it." });
    expect(parseEngagementScope({ offLimits: ["x.com"] }).ok).toBe(false);
  });

  it("clears with null and refuses a window that ends before it starts", () => {
    expect(parseEngagementScope(null)).toEqual({ ok: true, scope: undefined });
    expect(parseEngagementScope(undefined)).toEqual({ ok: true, scope: undefined });
    expect(parseEngagementScope({ targets: ["a.com"], startsAt: 5, endsAt: 5 }).ok).toBe(false);
    expect(parseEngagementScope({ targets: ["a.com"], startsAt: "now" }).ok).toBe(false);
    expect(parseEngagementScope({ targets: ["a.com"], startsAt: 1.5 }).ok).toBe(false);
    expect(parseEngagementScope({ targets: ["a.com"], endsAt: Number.MAX_VALUE }).ok).toBe(false);
    expect(parseEngagementScope({ targets: ["a.com"], endsAt: 8.64e15 + 1 }).ok).toBe(false);
    expect(parseEngagementScope({ targets: ["a.com"], endsAt: 8.64e15 }).ok).toBe(true);
  });

  it("matches an exact host, a subdomain of a wildcard, an address and a block, with off-limits winning", () => {
    const inScope = scope(["example.com", "*.acme.test", "10.0.0.0/24", "192.168.5.5"], ["admin.acme.test"]);
    expect(hostInScope(inScope, "example.com")).toBe(true);
    expect(hostInScope(inScope, "example.com.evil.test")).toBe(false);
    expect(hostInScope(inScope, "www.acme.test")).toBe(true);
    expect(hostInScope(inScope, "deep.www.acme.test")).toBe(true);
    expect(hostInScope(inScope, "acme.test")).toBe(false);
    expect(hostInScope(inScope, "admin.acme.test")).toBe(false);
    expect(hostInScope(inScope, "10.0.0.9")).toBe(true);
    expect(hostInScope(inScope, "10.0.1.9")).toBe(false);
    expect(hostInScope(inScope, "192.168.5.5")).toBe(true);
  });

  it("never treats the operator's own sandbox loopback as a client asset", () => {
    const inScope = scope(["example.com"]);
    expect(hostInScope(inScope, "localhost")).toBe(true);
    expect(hostInScope(inScope, "127.0.0.1")).toBe(true);
    expect(hostInScope(inScope, "127.9.9.9")).toBe(true);
    expect(hostInScope(inScope, "::1")).toBe(true);
  });
});

describe("engagement scope window", () => {
  it("is active with no window, and inactive outside one", () => {
    const open = scope(["a.com"]);
    expect(scopeActive(open, 0)).toBe(true);
    const bounded = scope(["a.com"], [], { startsAt: 100, endsAt: 200 });
    expect(scopeActive(bounded, 99)).toBe(false);
    expect(scopeActive(bounded, 100)).toBe(true);
    expect(scopeActive(bounded, 200)).toBe(true);
    expect(scopeActive(bounded, 201)).toBe(false);
  });
});

describe("reading a command's destinations", () => {
  it("reads hosts from URLs, bare addresses and bare names, dropping ports, credentials and case", () => {
    expect(commandDestinations("curl https://user:pw@Example.com:8443/path?q=1").sort())
      .toEqual(["example.com"]);
    expect(commandDestinations("nmap -sV 10.0.0.5").sort()).toEqual(["10.0.0.5"]);
    expect(commandDestinations("ffuf -u http://api.acme.test/FUZZ").sort()).toEqual(["api.acme.test"]);
    expect(commandDestinations("curl http://[::1]:8080/").sort()).toEqual(["::1"]);
  });

  it("does not read a path, a filename or a version number as a host", () => {
    for (const command of [
      "cat ./findings/report.md",
      "python3 /usr/lib/nmap/scripts/run.py",
      "cat notes/scan.txt",
      "tar xzf archive.tar.gz",
      "node --version > v20.11.1.log",
      "echo report.json",
    ]) {
      expect(commandDestinations(command), command).toEqual([]);
    }
  });

  it("deduplicates a host that appears many times", () => {
    expect(commandDestinations("curl a.com && curl a.com && nmap a.com").sort()).toEqual(["a.com"]);
  });

  it("reads an address written as one integer, in hex or decimal, as the address it is", () => {
    expect(commandDestinations("curl http://0xc0a80101/").sort()).toEqual(["192.168.1.1"]);
    expect(commandDestinations("curl http://3232235777/").sort()).toEqual(["192.168.1.1"]);
    expect(commandDestinations("curl http://0x7f000001/").sort()).toEqual(["127.0.0.1"]);
    expect(commandDestinations("exec 3<>/dev/tcp/3232235777/443").sort()).toEqual(["192.168.1.1"]);
  });

  it("does not read a lone 0x, an octal address or a value past the address range as an address", () => {
    for (const command of ["echo 0x", "cat 0xdeadbeef.log", "curl http://0177.0.0.1/", "curl http://4294967296/"]) {
      expect(commandDestinations(command), command).not.toContain("127.0.0.1");
    }
    expect(commandDestinations("curl http://0177.0.0.1/")).toEqual(["0177.0.0.1"]);
  });

  it("reads the host of bash's own network redirection", () => {
    expect(commandDestinations("cat < /dev/tcp/evil.com/80").sort()).toEqual(["evil.com"]);
    expect(commandDestinations("exec 3<>/dev/tcp/10.0.0.9/443").sort()).toEqual(["10.0.0.9"]);
    expect(commandDestinations("echo hi >/dev/udp/0xc0a80101/53").sort()).toEqual(["192.168.1.1"]);
  });

  it("leaves an ordinary device file alone", () => {
    for (const command of ["cat /dev/null", "head -c 16 /dev/urandom", "dd if=/dev/zero of=out.bin"]) {
      expect(commandDestinations(command), command).toEqual([]);
    }
  });
});

describe("checking a command against a scope", () => {
  it("allows a command whose every destination is authorized", () => {
    expect(checkCommand(scope(["example.com", "*.acme.test"]), "curl https://example.com && ffuf -u http://x.acme.test")).toEqual({ ok: true });
  });

  it("refuses a command that reaches outside, naming the hosts", () => {
    expect(checkCommand(scope(["example.com"]), "curl https://evil.test/")).toEqual({ ok: false, reason: "targets", hosts: ["evil.test"] });
    expect(checkCommand(scope(["example.com"], ["admin.example.com"]), "curl https://admin.example.com/"))
      .toEqual({ ok: false, reason: "targets", hosts: ["admin.example.com"] });
  });

  it("refuses an out-of-scope address however it is written, and a redirection to one", () => {
    const scoped = scope(["example.com"]);
    expect(checkCommand(scoped, "curl http://0xc0a80101/")).toEqual({ ok: false, reason: "targets", hosts: ["192.168.1.1"] });
    expect(checkCommand(scoped, "curl http://3232235777/")).toEqual({ ok: false, reason: "targets", hosts: ["192.168.1.1"] });
    expect(checkCommand(scoped, "cat < /dev/tcp/10.0.0.9/80")).toEqual({ ok: false, reason: "targets", hosts: ["10.0.0.9"] });
  });

  it("refuses every command outside the authorization window, and says which side", () => {
    const bounded = scope(["example.com"], [], { startsAt: 100, endsAt: 200 });
    expect(checkCommand(bounded, "curl https://example.com", 50)).toEqual({ ok: false, reason: "window", detail: "not started" });
    expect(checkCommand(bounded, "curl https://example.com", 500)).toEqual({ ok: false, reason: "window", detail: "ended" });
  });

  it("names the host and restates the scope, so the next command can be right", () => {
    const scoped = scope(["example.com"], ["admin.example.com"]);
    const check = checkCommand(scoped, "curl https://evil.test/");
    if (check.ok) throw new Error("expected a refusal");
    const text = scopeRefusalText(check, scoped);
    expect(text).toContain("evil.test");
    expect(text).toContain("example.com");
    expect(text).toContain("admin.example.com");
  });
});

describe("command scope", () => {
  const fixture = () => {
    mkdirSync(directory, { recursive: true });
    const scopes = new EngagementScopeStore(filename);
    const byThread = new Map([["room-a", "room-a"], ["room-b", "room-b"], ["job-a", "room-a"]]);
    const roomOfThread = (botId: string, threadId: string) => {
      const id = byThread.get(threadId);
      return id && botId === "member" ? ({ id, memberIds: ["member"] } as never) : null;
    };
    return { scopes, commandScope: createCommandScope({ roomOfThread, scopes }) };
  };

  it("refuses a command outside the room's scope and allows one inside it", () => {
    const { scopes, commandScope } = fixture();
    scopes.set("room-a", { targets: ["example.com"] });
    expect(commandScope.refusal("member", "room-a", "curl https://evil.test/")).toContain("evil.test");
    expect(commandScope.refusal("member", "room-a", "curl https://example.com/")).toBeNull();
  });

  it("reaches a room job's own thread, and refuses a caller who is not a member", () => {
    const { scopes, commandScope } = fixture();
    scopes.set("room-a", { targets: ["example.com"] });
    expect(commandScope.refusal("member", "job-a", "curl https://evil.test/")).toContain("evil.test");
    expect(commandScope.refusal("stranger", "job-a", "curl https://evil.test/")).toBeNull();
  });

  it("leaves a room with no scope unchecked, and states the scope for one that has it", () => {
    const { scopes, commandScope } = fixture();
    expect(commandScope.refusal("member", "room-b", "curl https://evil.test/")).toBeNull();
    expect(commandScope.prompt("room-b")).toBe(false);
    scopes.set("room-a", { targets: ["example.com"], offLimits: ["admin.example.com"] });
    const prompt = commandScope.prompt("room-a");
    expect(prompt).toContain("example.com");
    expect(prompt).toContain("admin.example.com");
  });

  it("reports each refusal once, with the room, the reason and the command, and stays quiet for an allowed one", () => {
    mkdirSync(directory, { recursive: true });
    const scopes = new EngagementScopeStore(filename);
    scopes.set("room-a", { targets: ["example.com"] });
    const seen: Array<{ roomId: string; reason: string; command: string }> = [];
    const roomOfThread = (botId: string, threadId: string) => (botId === "member" && threadId === "room-a" ? ({ id: "room-a", memberIds: ["member"] } as never) : null);
    const commandScope = createCommandScope({ roomOfThread, scopes, onRefusal: (roomId, check, command) => seen.push({ roomId, reason: check.reason, command }) });
    commandScope.refusal("member", "room-a", "curl https://example.com/");
    commandScope.refusal("member", "room-a", "curl https://evil.test/");
    expect(seen).toEqual([{ roomId: "room-a", reason: "targets", command: "curl https://evil.test/" }]);
  });

  describe("a desktop call", () => {
    it("reads exec's command and open_url's address, the two that name a host", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["example.com"] });
      expect(commandScope.call("member", "room-a", "exec", { command: "curl https://evil.test/" })).toContain("evil.test");
      expect(commandScope.call("member", "room-a", "open_url", { url: "https://evil.test/" })).toContain("evil.test");
      expect(commandScope.call("member", "room-a", "exec", { command: "curl https://example.com/" })).toBeNull();
      expect(commandScope.call("member", "room-a", "open_url", { url: "https://example.com/" })).toBeNull();
    });

    it("says nothing about a click, a screenshot or a keystroke, which name no host", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["example.com"] });
      for (const name of ["click", "screenshot", "move", "drag", "type_text", "key_press", "scroll", "get_screen_size"]) {
        expect(commandScope.call("member", "room-a", name, { x: 1, y: 2, text: "curl https://evil.test/" })).toBeNull();
      }
    });

    it("records the refusal the same way a command's is recorded, so the room sees what was reached for", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["example.com"] });
      commandScope.call("member", "room-a", "open_url", { url: "https://evil.test/" });
      expect(scopes.get("room-a")?.targets).toEqual(["example.com"]);
      expect(commandScope.call("stranger", "room-a", "open_url", { url: "https://evil.test/" })).toBeNull();
    });
  });

  describe("a browser connection", () => {
    it("refuses a name the room's scope does not cover and allows one it does", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["example.com"] });
      expect(commandScope.hostOutOfScope("member", "room-a", "evil.test")).toBe(true);
      expect(commandScope.hostOutOfScope("member", "room-a", "example.com")).toBe(false);
    });

    it("reads a wildcard's subdomain as in scope and an off-limits host as out of it", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["*.example.com"], offLimits: ["admin.example.com"] });
      expect(commandScope.hostOutOfScope("member", "room-a", "app.example.com")).toBe(false);
      expect(commandScope.hostOutOfScope("member", "room-a", "admin.example.com")).toBe(true);
      expect(commandScope.hostOutOfScope("member", "room-a", "example.com")).toBe(true);
    });

    it("leaves a room with no scope, and a caller outside the room, unchecked", () => {
      const { scopes, commandScope } = fixture();
      expect(commandScope.hostOutOfScope("member", "room-b", "evil.test")).toBe(false);
      scopes.set("room-a", { targets: ["example.com"] });
      expect(commandScope.hostOutOfScope("stranger", "room-a", "evil.test")).toBe(false);
    });

    it("refuses every name once the authorization window has closed, either side of it", () => {
      const { scopes, commandScope } = fixture();
      scopes.set("room-a", { targets: ["example.com"], startsAt: Date.now() + 60_000 });
      expect(commandScope.hostOutOfScope("member", "room-a", "example.com")).toBe(true);
      scopes.set("room-a", { targets: ["example.com"], endsAt: Date.now() - 60_000 });
      expect(commandScope.hostOutOfScope("member", "room-a", "example.com")).toBe(true);
      scopes.set("room-a", { targets: ["example.com"] });
      expect(commandScope.hostOutOfScope("member", "room-a", "example.com")).toBe(false);
    });

    it("records nothing, because a page opens many connections and the gate states the refusal itself", () => {
      const scopes = new EngagementScopeStore(join(directory, "browser-quiet.json"));
      scopes.set("room-a", { targets: ["example.com"] });
      const seen: unknown[] = [];
      const roomOfThread = (botId: string, threadId: string) => (botId === "member" && threadId === "room-a" ? ({ id: "room-a", memberIds: ["member"] } as never) : null);
      const commandScope = createCommandScope({ roomOfThread, scopes, onRefusal: (_roomId, check, command) => seen.push({ check, command }) });
      commandScope.hostOutOfScope("member", "room-a", "evil.test");
      expect(seen).toEqual([]);
    });
  });
});
