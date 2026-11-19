import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EngagementScope } from "../shared/engagement.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { GroupRecord } from "./store.ts";

// The targets one engagement authorizes, and the check a shell command's destinations pass before it runs.
//
// This is a heuristic on a command's text, not a sandbox: a destination written in a way the text does not
// reveal (an address built inside a script, a host behind a redirect) is not seen here. It stops the ordinary
// mistake of pointing an authorized engagement's tooling at the wrong host, and it is honest about that limit.
// An address spelled as one integer (`0xc0a80101`, `3232235777`) and bash's `/dev/tcp/host/port` redirection
// are read, since both name a destination plainly; a bare integer token elsewhere is not, since it is far more
// often a timestamp or an id than an address.

export type { EngagementScope };

export type ParsedEngagementScope =
  | { ok: true; scope: EngagementScope | undefined }
  | { ok: false; error: string };

export type ScopeCheck =
  | { ok: true }
  | { ok: false; reason: "window"; detail: "not started" | "ended" }
  | { ok: false; reason: "targets"; hosts: string[] };

const MAX_TARGETS = 200;
const MAX_TARGET_LENGTH = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Leading zeros are ambiguous enough that `010.0.0.1` is not read as an address. */
const OCTET = /^(?:0|[1-9]\d{0,2})$/;

/** File extensions common enough that a bare token ending in one is read as a file, never a host.
 *
 * The cost is real and one-way: an out-of-scope host whose last label is one of these is not blocked. It buys
 * not blocking the operator's own notes, scripts and evidence files, which is the far more common event. */
const FILE_LIKE: ReadonlySet<string> = new Set([
  "json", "txt", "log", "yaml", "yml", "csv", "tsv", "md", "markdown", "rst", "tex",
  "html", "htm", "xml", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "tar", "gz", "tgz", "bz2", "xz",
  "whl", "rpm", "deb", "jar", "lock", "toml", "ini", "cfg", "conf", "sqlite", "sqlite3",
  "db", "tmp", "bak", "orig", "pyc", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh",
  "bash", "zsh", "fish", "pl", "rb", "php", "go", "rs", "java", "kt", "swift", "c", "h",
  "cc", "cpp", "hpp", "o", "a", "so", "dll", "dylib", "exe", "bin", "out", "err", "patch",
  "diff", "pem", "crt", "cer", "key", "pub", "p12", "pfx", "map", "min", "cache", "sql", "env",
]);

/** The IPv4 value of dotted-quad text, or null. */
function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    total = total * 256 + octet;
  }
  return total;
}

function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

/** An address written as one integer: `0xc0a80101` and `3232235777` both mean 192.168.1.1, and a command that
 * wants past a check on host names writes one. A lone `0x`, a leading zero (octal to a shell) or a value past
 * the address range is not read as an address. */
function ipv4FromInteger(value: string): string | null {
  const hex = /^0x([0-9a-f]{1,8})$/.exec(value);
  const decimal = /^(?:0|[1-9]\d{0,9})$/.test(value) ? value : null;
  if (!hex && decimal === null) return null;
  const n = hex ? Number.parseInt(hex[1]!, 16) : Number(decimal);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? ipv4Text(n) : null;
}

/** A dotted host of at least two labels, lowercased. A single label is not a client host. */
function hostName(value: string): string | null {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host.length < 3 || host.length > MAX_TARGET_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return host;
}

function ipv6Literal(value: string): string | null {
  return value.includes(":") && value.split(":").length >= 3 ? value.toLowerCase() : null;
}

/** One scope entry, normalized: an address, a CIDR block masked to its network, a wildcard or a host. */
export function normalizeScopeTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > MAX_TARGET_LENGTH + 2) return null;
  if (raw.startsWith("*.")) {
    const host = hostName(raw.slice(2));
    return host ? `*.${host}` : null;
  }
  if (raw.includes("/")) {
    const slash = raw.indexOf("/");
    const base = ipv4Number(raw.slice(0, slash));
    const bitsText = raw.slice(slash + 1);
    if (base === null || !/^\d{1,2}$/.test(bitsText)) return null;
    const bits = Number(bitsText);
    if (bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return `${ipv4Text((base & mask) >>> 0)}/${bits}`;
  }
  if (ipv4Number(raw) !== null) return raw;
  // Four numeric labels that are not a valid address are a mistyped address, never a host.
  if (/^\d+(?:\.\d+){3}$/.test(raw)) return null;
  return ipv6Literal(raw) ?? hostName(raw);
}

export function parseEngagementScope(value: unknown): ParsedEngagementScope {
  if (value === undefined || value === null) return { ok: true, scope: undefined };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "An engagement scope must be an object." };
  const record = value as Record<string, unknown>;
  // A mistyped field ("target" for "targets") would otherwise silently widen or narrow what the scope means.
  const unknown = Object.keys(record).find((key) => !["targets", "offLimits", "startsAt", "endsAt"].includes(key));
  if (unknown) return { ok: false, error: `Unknown engagement scope field "${unknown}".` };
  const list = (input: unknown, label: string): string[] | { error: string } => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_TARGETS) return { error: `${label} must be a list of at most ${MAX_TARGETS} targets.` };
    const out: string[] = [];
    for (const entry of Array.from(input)) {
      const target = normalizeScopeTarget(entry);
      if (!target) return { error: `${label} holds something that is not a host, a wildcard, an IP address or a CIDR block.` };
      if (!out.includes(target)) out.push(target);
    }
    return out;
  };
  const targets = list(record.targets, "targets");
  if (!Array.isArray(targets)) return { ok: false, error: targets.error };
  const offLimits = list(record.offLimits, "offLimits");
  if (!Array.isArray(offLimits)) return { ok: false, error: offLimits.error };
  // A scope with no authorized target would refuse every command; a person who means to clear it sends null.
  if (targets.length === 0) return { ok: false, error: "An engagement scope needs at least one authorized target. Send null to clear it." };
  const time = (input: unknown): number | undefined | null => {
    if (input === undefined) return undefined;
    // Bounded so a window always formats as a date: an out-of-range time would throw while the room prompt is built.
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 8.64e15 ? input : null;
  };
  const startsAt = time(record.startsAt);
  const endsAt = time(record.endsAt);
  if (startsAt === null || endsAt === null) return { ok: false, error: "An authorization window is a time in milliseconds." };
  if (startsAt !== undefined && endsAt !== undefined && endsAt <= startsAt) return { ok: false, error: "The authorization window ends before it starts." };
  return {
    ok: true,
    scope: {
      targets,
      offLimits,
      ...(startsAt === undefined ? {} : { startsAt }),
      ...(endsAt === undefined ? {} : { endsAt }),
    },
  };
}

/** The operator's own sandbox is not a client asset, so its loopback is never what a scope is about. */
function loopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const address = ipv4Number(host);
  return address !== null && address >>> 24 === 127;
}

function targetMatches(target: string, host: string): boolean {
  if (target.startsWith("*.")) return host.endsWith(target.slice(1));
  if (target.includes("/")) {
    const slash = target.indexOf("/");
    const base = ipv4Number(target.slice(0, slash));
    const address = ipv4Number(host);
    if (base === null || address === null) return false;
    const bits = Number(target.slice(slash + 1));
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((address & mask) >>> 0) === base;
  }
  const literal = ipv4Number(target);
  return literal === null ? target === host : literal === ipv4Number(host);
}

export function hostInScope(scope: EngagementScope, host: string): boolean {
  if (loopback(host)) return true;
  if (scope.offLimits.some((target) => targetMatches(target, host))) return false;
  return scope.targets.some((target) => targetMatches(target, host));
}

/** The host an asset's location names — a URL's authority, `host:port`, or a bare host — or null when it names
 * none. Read against the scope to tell a client's asset from something the team should not have recorded. */
export function assetLocationHost(location: string): string | null {
  const value = location.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  const authority = scheme ? (value.slice(scheme[0].length).split(/[/?#]/)[0] ?? "") : value;
  return authorityHost(authority);
}

export function scopeActive(scope: EngagementScope, now: number): boolean {
  return (scope.startsAt === undefined || now >= scope.startsAt) && (scope.endsAt === undefined || now <= scope.endsAt);
}

const URL_AUTHORITY = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'`<>()\\]+)/gi;
const IPV4_IN_TEXT = /\b(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d{1,2})?\b/g;
const HOST_IN_TEXT = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/gi;
/** Bash's own network redirection, `/dev/tcp/host/port`: the host is a destination the path rule below would
 * otherwise read as a file inside `/dev`. */
const DEV_NET = /\/dev\/(?:tcp|udp)\/([^\s/?#]+)/gi;

function authorityHost(authority: string): string | null {
  let value = authority;
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.indexOf(":");
  if (colon >= 0) value = value.slice(0, colon);
  if (!value) return null;
  if (ipv4Number(value) !== null) return value;
  return ipv4FromInteger(value) ?? ipv6Literal(value) ?? hostName(value);
}

/** Every host a command's text could send traffic to, lowercased and deduplicated. */
export function commandDestinations(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(URL_AUTHORITY)) {
    const host = authorityHost(match[1] ?? "");
    if (host) found.add(host);
  }
  for (const match of command.matchAll(IPV4_IN_TEXT)) found.add(match[1]!);
  for (const match of command.matchAll(DEV_NET)) {
    const host = ipv4Number(match[1]!) !== null ? match[1]! : (ipv4FromInteger(match[1]!) ?? hostName(match[1]!));
    if (host) found.add(host);
  }
  for (const match of command.matchAll(HOST_IN_TEXT)) {
    const before = command[(match.index ?? 0) - 1];
    // Inside a path it is a file, not a host: /usr/lib/libc.so, ./notes/findings.md.
    if (before === "/" || before === "\\" || before === "~") continue;
    const host = hostName(match[1]!);
    if (!host || FILE_LIKE.has(host.slice(host.lastIndexOf(".") + 1))) continue;
    found.add(host);
  }
  return [...found];
}

export function checkCommand(scope: EngagementScope, command: string, now = Date.now()): ScopeCheck {
  if (!scopeActive(scope, now)) {
    const early = scope.startsAt !== undefined && now < scope.startsAt;
    return { ok: false, reason: "window", detail: early ? "not started" : "ended" };
  }
  const hosts = commandDestinations(command).filter((host) => !hostInScope(scope, host));
  return hosts.length ? { ok: false, reason: "targets", hosts: hosts.slice(0, 5) } : { ok: true };
}

export type ScopeRefusal = Extract<ScopeCheck, { ok: false }>;

/** What the operator is told when a command is refused. It names the host and restates the scope, so the next
 * command can be right rather than guessed. */
export function scopeRefusalText(check: ScopeRefusal, scope: EngagementScope): string {
  if (check.reason === "window") {
    return check.detail === "not started"
      ? "Refused: this engagement's authorization window has not started yet."
      : "Refused: this engagement's authorization window has ended.";
  }
  const off = scope.offLimits.length ? ` Off-limits: ${scope.offLimits.join(", ")}.` : "";
  return `Refused: ${check.hosts.join(", ")} is outside this engagement's authorized scope. In scope: ${scope.targets.join(", ")}.${off}`;
}

const MAX_STORE_BYTES = 2 * 1024 * 1024;
const ROOM_ID = /^[\w-]{1,128}$/;
const FILE_VERSION = 1;

interface StoredScope {
  roomId: string;
  scope: EngagementScope;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): Error => Object.assign(new Error(message), { status: 400 });

function validateRoomId(roomId: string): void {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) throw invalid("A valid room id is required.");
}

/** Installation-local authorizations, apart from room records so no tool can widen one: a scope only ever refuses. */
export class EngagementScopeStore {
  private scopes: StoredScope[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid engagement scope store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.scopes) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "scopes")) throw new Error("Invalid engagement scope store.");
      const scopes: StoredScope[] = [];
      const seen = new Set<string>();
      for (const row of saved.scopes) {
        if (!record(row) || typeof row.roomId !== "string" || !ROOM_ID.test(row.roomId) || seen.has(row.roomId)) {
          throw new Error("Invalid engagement scope store.");
        }
        const parsed = parseEngagementScope(row.scope);
        if (!parsed.ok || !parsed.scope) throw new Error("Invalid engagement scope store.");
        seen.add(row.roomId);
        scopes.push({ roomId: row.roomId, scope: parsed.scope });
      }
      this.scopes = scopes;
    } catch (error) {
      // Missing means no scope anywhere; any other failure refuses every change rather than overwrite a damaged store.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  get(roomId: string): EngagementScope | null {
    if (this.unreadable || typeof roomId !== "string") return null;
    const found = this.scopes.find((row) => row.roomId === roomId);
    return found ? { ...found.scope, targets: [...found.scope.targets], offLimits: [...found.scope.offLimits] } : null;
  }

  set(roomId: string, value: unknown): EngagementScope | null {
    this.assertWritable();
    validateRoomId(roomId);
    const parsed = parseEngagementScope(value);
    if (!parsed.ok) throw invalid(parsed.error);
    if (!parsed.scope) {
      this.clear(roomId);
      return null;
    }
    this.save([...this.scopes.filter((row) => row.roomId !== roomId), { roomId, scope: parsed.scope }]);
    return parsed.scope;
  }

  clear(roomId: string): boolean {
    this.assertWritable();
    validateRoomId(roomId);
    const next = this.scopes.filter((row) => row.roomId !== roomId);
    if (next.length === this.scopes.length) return false;
    this.save(next);
    return true;
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Engagement scopes could not be read. Repair the store before changing them."), { status: 503 });
  }

  private save(scopes: StoredScope[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, scopes }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw invalid("The engagement scopes exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.scopes = scopes;
  }
}

/** The engagement's authorization as the room's members see it. A room without one runs commands unchecked. */
function scopePrompt(scope: EngagementScope | null): string | false {
  if (!scope) return false;
  const window = [
    scope.startsAt === undefined ? "" : `from ${new Date(scope.startsAt).toISOString()}`,
    scope.endsAt === undefined ? "" : `until ${new Date(scope.endsAt).toISOString()}`,
  ].filter(Boolean).join(" ");
  return `Engagement scope (this room's authorization): in scope ${scope.targets.join(", ")}${window ? `, ${window}` : ""}.` +
    (scope.offLimits.length ? ` Off-limits: ${scope.offLimits.join(", ")}.` : "") +
    " A command that reaches a host outside this scope is refused before it runs; keep to the targets above, and report a target you cannot reach rather than working around the check.";
}

/** Ties a scope store to the rooms that own it. `roomOfThread` resolves a room job's own thread to its room, so
 * the check reaches every member's commands before the container runs anything. */
export function createCommandScope(deps: {
  roomOfThread(botId: string, threadId: string): GroupRecord | null;
  scopes: EngagementScopeStore;
  /** Every refusal, at the one place commands are checked, so the room's surface can show what the team reached for. */
  onRefusal?(roomId: string, check: ScopeRefusal, command: string): void;
}) {
  /** Why a command from `botId` may not run, or null. Only ever refuses; a room without a scope is unchecked. */
  const refusal = (botId: string, threadId: string, command: string): string | null => {
    const room = deps.roomOfThread(botId, threadId);
    const scope = room ? deps.scopes.get(room.id) : null;
    if (!scope) return null;
    const verdict = checkCommand(scope, command);
    if (verdict.ok) return null;
    if (room) deps.onRefusal?.(room.id, verdict, command);
    return scopeRefusalText(verdict, scope);
  };
  /** Whether a browser connection from `botId` to `host` falls outside the room's authorization. Read by name at the
   * egress gate, before a DNS lookup. Pure: a page can open many connections, so this records nothing — the gate's own
   * page-health line is where the refusal surfaces, as it does for every other egress refusal. */
  const hostOutOfScope = (botId: string, threadId: string, host: string, now = Date.now()): boolean => {
    const room = deps.roomOfThread(botId, threadId);
    const scope = room ? deps.scopes.get(room.id) : null;
    if (!scope) return false;
    return !scopeActive(scope, now) || !hostInScope(scope, host);
  };
  return {
    /** The line a room's members read; false when the room holds no authorization. */
    prompt(groupId: string): string | false {
      return scopePrompt(deps.scopes.get(groupId));
    },
    refusal,
    hostOutOfScope,
    /**
     * Why a desktop call from `botId` may not reach the host it names, or null. Only the arguments that carry a
     * destination are read: `exec`'s command and `open_url`'s address. Every other desktop action, a click included,
     * names no host, so a room's scope cannot speak to it.
     */
    call(botId: string, threadId: string, name: unknown, args: unknown): string | null {
      const field = name === "exec" ? "command" : name === "open_url" ? "url" : null;
      const value = field === null ? null : (args as Record<string, unknown> | null | undefined)?.[field];
      return typeof value === "string" ? refusal(botId, threadId, value) : null;
    },
  };
}
