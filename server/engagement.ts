// An engagement's four room-scoped ledgers, and the check a command's destinations pass before it runs:
//
// - the scope the client authorized, and the refusal of a command that leaves it;
// - the assets the team found inside it (what exists to be tested);
// - the findings the team proved under it (what is wrong);
// - the refusals of what the team reached for outside it.
//
// All four live apart from the room records, so no tool can widen one: a scope only ever refuses. None is a place
// a command runs from.
//
// The scope check is a heuristic on a command's text, not a sandbox: a destination written in a way the text does
// not reveal (an address built inside a script, a host behind a redirect) is not seen here. It stops the ordinary
// mistake of pointing an authorized engagement's tooling at the wrong host, and it is honest about that limit.
// An address spelled as one integer (`0xc0a80101`, `3232235777`) and bash's `/dev/tcp/host/port` redirection are
// read, since both name a destination plainly; a bare integer token elsewhere is not, since it is far more often a
// timestamp or an id than an address.

import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ASSET_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type AssetKind,
  type EngagementAsset,
  type EngagementFinding,
  type EngagementRefusal,
  type EngagementScope,
  type FindingSeverity,
  type FindingStatus,
} from "../shared/engagement.ts";
import { scrubHeldSecrets } from "../shared/redact.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { GroupRecord } from "./store.ts";

export { ASSET_KINDS, FINDING_SEVERITIES, FINDING_STATUSES };
export type {
  AssetKind,
  EngagementAsset,
  EngagementFinding,
  EngagementRefusal,
  EngagementScope,
  FindingSeverity,
  FindingStatus,
};

const ROOM_ID = /^[\w-]{1,128}$/;
const FILE_VERSION = 1;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): Error => Object.assign(new Error(message), { status: 400 });
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function validateRoomId(roomId: string): void {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) throw invalid("A valid room id is required.");
}

// ---------------------------------------------------------------------------------------------------------------
// Scope: the targets one engagement authorizes, and the check a command's destinations pass before it runs.
// ---------------------------------------------------------------------------------------------------------------

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
  const fields = value as Record<string, unknown>;
  // A mistyped field ("target" for "targets") would otherwise silently widen or narrow what the scope means.
  const unknown = Object.keys(fields).find((key) => !["targets", "offLimits", "startsAt", "endsAt"].includes(key));
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
  const targets = list(fields.targets, "targets");
  if (!Array.isArray(targets)) return { ok: false, error: targets.error };
  const offLimits = list(fields.offLimits, "offLimits");
  if (!Array.isArray(offLimits)) return { ok: false, error: offLimits.error };
  // A scope with no authorized target would refuse every command; a person who means to clear it sends null.
  if (targets.length === 0) return { ok: false, error: "An engagement scope needs at least one authorized target. Send null to clear it." };
  const time = (input: unknown): number | undefined | null => {
    if (input === undefined) return undefined;
    // Bounded so a window always formats as a date: an out-of-range time would throw while the room prompt is built.
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= 8.64e15 ? input : null;
  };
  const startsAt = time(fields.startsAt);
  const endsAt = time(fields.endsAt);
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

const SCOPE_MAX_STORE_BYTES = 2 * 1024 * 1024;

interface StoredScope {
  roomId: string;
  scope: EngagementScope;
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
      if (!stat.isFile() || stat.size > SCOPE_MAX_STORE_BYTES) throw new Error("Invalid engagement scope store.");
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
    if (Buffer.byteLength(json) > SCOPE_MAX_STORE_BYTES) throw invalid("The engagement scopes exceed the storage limit.");
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
  return {
    /** The line a room's members read; false when the room holds no authorization. */
    prompt(groupId: string): string | false {
      return scopePrompt(deps.scopes.get(groupId));
    },
    refusal,
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

// ---------------------------------------------------------------------------------------------------------------
// Findings: the flaws one engagement has found, as the team recorded them. A finding is a claim until evidence is
// attached, which is what separates this ledger from a scanner's raw output.
// ---------------------------------------------------------------------------------------------------------------

export type ParsedFinding =
  | { ok: true; finding: Omit<EngagementFinding, "id" | "reportedAt" | "updatedAt"> }
  | { ok: false; error: string };

const FINDINGS_MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS_PER_ROOM = 500;
const MAX_TEXT = 4000;
const MAX_TITLE = 300;
const MAX_FINDING_TARGET = 300;
const MAX_EVIDENCE = 8000;

/** What a bot or the person sends. The store stamps the id and the times. */
export function parseFinding(value: unknown): ParsedFinding {
  if (!record(value)) return { ok: false, error: "A finding must be an object." };
  const target = text(value.target);
  if (!target) return { ok: false, error: "A finding needs a target: the host, endpoint or path it is in." };
  if (target.length > MAX_FINDING_TARGET) return { ok: false, error: `The target must be at most ${MAX_FINDING_TARGET} characters.` };
  const title = text(value.title);
  if (!title) return { ok: false, error: "A finding needs a title: what is wrong, in one line." };
  if (title.length > MAX_TITLE) return { ok: false, error: `The title must be at most ${MAX_TITLE} characters.` };
  const severity = value.severity ?? "medium";
  if (!FINDING_SEVERITIES.includes(severity as FindingSeverity)) {
    return { ok: false, error: `severity must be one of ${FINDING_SEVERITIES.join(", ")}.` };
  }
  const status = value.status ?? "suspected";
  if (!FINDING_STATUSES.includes(status as FindingStatus)) {
    return { ok: false, error: `status must be one of ${FINDING_STATUSES.join(", ")}.` };
  }
  const evidence = text(value.evidence);
  if (!evidence) return { ok: false, error: "A finding needs evidence: the command and its output, the request and its response, or the artifact that shows it." };
  if (evidence.length > MAX_EVIDENCE) return { ok: false, error: `The evidence must be at most ${MAX_EVIDENCE} characters.` };
  const proof = text(value.proof);
  if (proof && proof.length > MAX_EVIDENCE) return { ok: false, error: `The proof must be at most ${MAX_EVIDENCE} characters.` };
  if (status === "proven" && !proof) {
    return { ok: false, error: "A finding is proven only with proof: the exact request that reproduces it and the response that shows the flaw, or the command and the output it produced. Record it as suspected until that exists." };
  }
  const detail = text(value.detail);
  if (detail && detail.length > MAX_TEXT) return { ok: false, error: `The detail must be at most ${MAX_TEXT} characters.` };
  return {
    ok: true,
    finding: {
      target,
      title,
      severity: severity as FindingSeverity,
      status: status as FindingStatus,
      evidence,
      ...(proof ? { proof } : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

/** Two findings with the same target and title, ignoring case and surrounding space, are the same finding. */
export function findingKey(target: string, title: string): string {
  return `${target.trim().toLowerCase()}\u0000${title.trim().toLowerCase()}`;
}

interface StoredFindingsRoom {
  roomId: string;
  findings: EngagementFinding[];
}

function loadFinding(row: unknown): EngagementFinding {
  if (!record(row) || typeof row.id !== "string" || typeof row.reportedAt !== "number" || typeof row.updatedAt !== "number") {
    throw new Error("Invalid engagement findings store.");
  }
  // A finding recorded before proof was required keeps its evidence but loses a `proven` label it never earned.
  const demoted = row.status === "proven" && !text(row.proof) ? { ...row, status: "suspected" } : row;
  const parsed = parseFinding(demoted);
  if (!parsed.ok) throw new Error("Invalid engagement findings store.");
  return { id: row.id, reportedAt: row.reportedAt, updatedAt: row.updatedAt, ...parsed.finding };
}

/** The findings of every engagement, apart from the room records so a room's own history cannot rewrite them. */
export class EngagementFindingsStore {
  private rooms: StoredFindingsRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > FINDINGS_MAX_STORE_BYTES) throw new Error("Invalid engagement findings store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement findings store.");
      const rooms: StoredFindingsRoom[] = [];
      const seen = new Set<string>();
      for (const room of saved.rooms) {
        if (!record(room) || typeof room.roomId !== "string" || !ROOM_ID.test(room.roomId) || !Array.isArray(room.findings) || seen.has(room.roomId)) {
          throw new Error("Invalid engagement findings store.");
        }
        seen.add(room.roomId);
        rooms.push({ roomId: room.roomId, findings: room.findings.map(loadFinding) });
      }
      this.rooms = rooms;
    } catch (error) {
      // Missing means no findings anywhere; any other failure refuses every change rather than overwrite a damaged store.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  list(roomId: string): EngagementFinding[] {
    if (this.unreadable || typeof roomId !== "string") return [];
    const room = this.rooms.find((row) => row.roomId === roomId);
    return room ? room.findings.map((finding) => ({ ...finding })) : [];
  }

  /** A finding already recorded for this target and title, or null. */
  find(roomId: string, target: string, title: string): EngagementFinding | null {
    const key = findingKey(target, title);
    return this.list(roomId).find((finding) => findingKey(finding.target, finding.title) === key) ?? null;
  }

  /** Record a new finding, or update the one with the same target and title. Returns it either way. */
  record(roomId: string, value: unknown, at = Date.now()): EngagementFinding {
    this.assertWritable();
    validateRoomId(roomId);
    const parsed = parseFinding(value);
    if (!parsed.ok) throw invalid(parsed.error);
    const existing = this.find(roomId, parsed.finding.target, parsed.finding.title);
    if (existing) return this.patch(roomId, existing.id, parsed.finding, at);
    const room = this.rooms.find((row) => row.roomId === roomId);
    if (room && room.findings.length >= MAX_FINDINGS_PER_ROOM) {
      throw invalid(`This engagement already holds ${MAX_FINDINGS_PER_ROOM} findings. Resolve or remove some before adding more.`);
    }
    const finding: EngagementFinding = { id: this.newId(), reportedAt: at, updatedAt: at, ...parsed.finding };
    this.save(this.withRoom(roomId, [...(room?.findings ?? []), finding]));
    return { ...finding };
  }

  patch(roomId: string, id: string, value: unknown, at = Date.now()): EngagementFinding {
    this.assertWritable();
    validateRoomId(roomId);
    const room = this.rooms.find((row) => row.roomId === roomId);
    const current = room?.findings.find((finding) => finding.id === id);
    if (!current) throw Object.assign(new Error("No such finding in this engagement."), { status: 404 });
    const merged = { ...current, ...(record(value) ? value : {}) };
    const parsed = parseFinding(merged);
    if (!parsed.ok) throw invalid(parsed.error);
    const updated: EngagementFinding = { ...current, ...parsed.finding, updatedAt: at };
    this.save(this.withRoom(roomId, room!.findings.map((finding) => (finding.id === id ? updated : finding))));
    return { ...updated };
  }

  remove(roomId: string, id: string): boolean {
    this.assertWritable();
    validateRoomId(roomId);
    const room = this.rooms.find((row) => row.roomId === roomId);
    if (!room) return false;
    const next = room.findings.filter((finding) => finding.id !== id);
    if (next.length === room.findings.length) return false;
    this.save(next.length ? this.withRoom(roomId, next) : this.rooms.filter((row) => row.roomId !== roomId));
    return true;
  }

  private withRoom(roomId: string, findings: EngagementFinding[]): StoredFindingsRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, findings }];
  }

  private newId(): string {
    return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Engagement findings could not be read. Repair the store before changing them."), { status: 503 });
  }

  private save(rooms: StoredFindingsRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > FINDINGS_MAX_STORE_BYTES) throw invalid("The engagement findings exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Assets: what one engagement found inside its authorized scope. The findings say what is wrong with them; this
// says what there is. A scan's raw output becomes this ledger by the bot recording each thing it turns up, so a
// later turn works from what the team has, not from memory.
// ---------------------------------------------------------------------------------------------------------------

export type ParsedAsset =
  | { ok: true; asset: Omit<EngagementAsset, "id" | "firstSeenAt" | "lastSeenAt"> }
  | { ok: false; error: string };

const ASSETS_MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS_PER_ROOM = 1000;
const MAX_LOCATION = 500;
const MAX_SERVICE = 200;
const MAX_BANNER = 2000;
const MAX_DISCOVERED = 1000;
const MAX_NOTES = 4000;

/** What a bot or the person sends. The store stamps the id and the times. */
export function parseAsset(value: unknown): ParsedAsset {
  if (!record(value)) return { ok: false, error: "An asset must be an object." };
  const location = text(value.location);
  if (!location) return { ok: false, error: "An asset needs a location: a host, `host:port`, or a URL." };
  if (location.length > MAX_LOCATION) return { ok: false, error: `The location must be at most ${MAX_LOCATION} characters.` };
  const kind = value.kind ?? "host";
  if (!ASSET_KINDS.includes(kind as AssetKind)) {
    return { ok: false, error: `kind must be one of ${ASSET_KINDS.join(", ")}.` };
  }
  const discoveredBy = text(value.discoveredBy);
  if (!discoveredBy) return { ok: false, error: "An asset needs discoveredBy: the command, scan or source that turned it up." };
  if (discoveredBy.length > MAX_DISCOVERED) return { ok: false, error: `discoveredBy must be at most ${MAX_DISCOVERED} characters.` };
  const service = text(value.service);
  if (service && service.length > MAX_SERVICE) return { ok: false, error: `The service must be at most ${MAX_SERVICE} characters.` };
  const banner = text(value.banner);
  if (banner && banner.length > MAX_BANNER) return { ok: false, error: `The banner must be at most ${MAX_BANNER} characters.` };
  const notes = text(value.notes);
  if (notes && notes.length > MAX_NOTES) return { ok: false, error: `The notes must be at most ${MAX_NOTES} characters.` };
  return {
    ok: true,
    asset: {
      location,
      kind: kind as AssetKind,
      ...(service ? { service } : {}),
      ...(banner ? { banner } : {}),
      discoveredBy,
      ...(notes ? { notes } : {}),
    },
  };
}

/** Two assets at the same location, ignoring case and a trailing slash, are the same asset: a scan that returns
 * `https://app.example.com/` and a later `https://app.example.com` describe one thing. */
export function assetKey(location: string): string {
  return location.trim().toLowerCase().replace(/\/+$/, "");
}

interface StoredAssetsRoom {
  roomId: string;
  assets: EngagementAsset[];
}

function loadAsset(row: unknown): EngagementAsset {
  if (!record(row) || typeof row.id !== "string" || typeof row.firstSeenAt !== "number" || typeof row.lastSeenAt !== "number") {
    throw new Error("Invalid engagement assets store.");
  }
  const parsed = parseAsset(row);
  if (!parsed.ok) throw new Error("Invalid engagement assets store.");
  return { id: row.id, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, ...parsed.asset };
}

/** The assets of every engagement, apart from the room records so a room's own history cannot rewrite them. */
export class EngagementAssetsStore {
  private rooms: StoredAssetsRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > ASSETS_MAX_STORE_BYTES) throw new Error("Invalid engagement assets store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement assets store.");
      const rooms: StoredAssetsRoom[] = [];
      const seen = new Set<string>();
      for (const room of saved.rooms) {
        if (!record(room) || typeof room.roomId !== "string" || !ROOM_ID.test(room.roomId) || !Array.isArray(room.assets) || seen.has(room.roomId)) {
          throw new Error("Invalid engagement assets store.");
        }
        seen.add(room.roomId);
        rooms.push({ roomId: room.roomId, assets: room.assets.map(loadAsset) });
      }
      this.rooms = rooms;
    } catch (error) {
      // Missing means no assets anywhere; any other failure refuses every change rather than overwrite a damaged store.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  list(roomId: string): EngagementAsset[] {
    if (this.unreadable || typeof roomId !== "string") return [];
    const room = this.rooms.find((row) => row.roomId === roomId);
    return room ? room.assets.map((asset) => ({ ...asset })) : [];
  }

  /** An asset already recorded at this location, or null. */
  find(roomId: string, location: string): EngagementAsset | null {
    const key = assetKey(location);
    return this.list(roomId).find((asset) => assetKey(asset.location) === key) ?? null;
  }

  /** Record an asset, or refresh the one at the same location. The first sighting keeps its time either way. */
  record(roomId: string, value: unknown, at = Date.now()): EngagementAsset {
    this.assertWritable();
    validateRoomId(roomId);
    const parsed = parseAsset(value);
    if (!parsed.ok) throw invalid(parsed.error);
    const existing = this.find(roomId, parsed.asset.location);
    if (existing) return this.patch(roomId, existing.id, parsed.asset, at);
    const room = this.rooms.find((row) => row.roomId === roomId);
    if (room && room.assets.length >= MAX_ASSETS_PER_ROOM) {
      throw invalid(`This engagement already holds ${MAX_ASSETS_PER_ROOM} assets. Remove some before adding more.`);
    }
    const asset: EngagementAsset = { id: this.newId(), firstSeenAt: at, lastSeenAt: at, ...parsed.asset };
    this.save(this.withRoom(roomId, [...(room?.assets ?? []), asset]));
    return { ...asset };
  }

  patch(roomId: string, id: string, value: unknown, at = Date.now()): EngagementAsset {
    this.assertWritable();
    validateRoomId(roomId);
    const room = this.rooms.find((row) => row.roomId === roomId);
    const current = room?.assets.find((asset) => asset.id === id);
    if (!current) throw Object.assign(new Error("No such asset in this engagement."), { status: 404 });
    const merged = { ...current, ...(record(value) ? value : {}) };
    const parsed = parseAsset(merged);
    if (!parsed.ok) throw invalid(parsed.error);
    const updated: EngagementAsset = { ...current, ...parsed.asset, lastSeenAt: at };
    this.save(this.withRoom(roomId, room!.assets.map((asset) => (asset.id === id ? updated : asset))));
    return { ...updated };
  }

  remove(roomId: string, id: string): boolean {
    this.assertWritable();
    validateRoomId(roomId);
    const room = this.rooms.find((row) => row.roomId === roomId);
    if (!room) return false;
    const next = room.assets.filter((asset) => asset.id !== id);
    if (next.length === room.assets.length) return false;
    this.save(next.length ? this.withRoom(roomId, next) : this.rooms.filter((row) => row.roomId !== roomId));
    return true;
  }

  private withRoom(roomId: string, assets: EngagementAsset[]): StoredAssetsRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, assets }];
  }

  private newId(): string {
    return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Engagement assets could not be read. Repair the store before changing them."), { status: 503 });
  }

  private save(rooms: StoredAssetsRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > ASSETS_MAX_STORE_BYTES) throw invalid("The engagement assets exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals: the commands one engagement's scope refused before they ran, as the team reached for them. A refusal
// is the other half of the ledger: the findings say what the team proved inside the scope, this says what it
// reached for outside it.
// ---------------------------------------------------------------------------------------------------------------

const REFUSALS_MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_REFUSALS_PER_ROOM = 200;
const MAX_COMMAND = 2000;

interface StoredRefusalsRoom {
  roomId: string;
  refusals: EngagementRefusal[];
}

function loadRefusal(row: unknown): EngagementRefusal {
  if (!record(row) || typeof row.id !== "string" || typeof row.command !== "string" ||
    (row.reason !== "targets" && row.reason !== "window") || !Array.isArray(row.hosts) ||
    typeof row.attempts !== "number" || typeof row.at !== "number") {
    throw new Error("Invalid engagement refusals store.");
  }
  const window = row.window === "not started" || row.window === "ended" ? row.window : undefined;
  return {
    id: row.id,
    command: row.command,
    reason: row.reason,
    hosts: row.hosts.filter((host): host is string => typeof host === "string"),
    ...(window ? { window } : {}),
    attempts: row.attempts,
    at: row.at,
  };
}

/** Two refusals of the same command text, for the same reason, are the same refusal. */
export function refusalKey(refusal: Pick<EngagementRefusal, "command" | "reason">): string {
  return `${refusal.reason}\u0000${refusal.command}`;
}

/** The refusals of every engagement, apart from the room records so a room's own history cannot rewrite them. */
export class EngagementRefusalsStore {
  private rooms: StoredRefusalsRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > REFUSALS_MAX_STORE_BYTES) throw new Error("Invalid engagement refusals store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement refusals store.");
      const rooms: StoredRefusalsRoom[] = [];
      const seen = new Set<string>();
      for (const room of saved.rooms) {
        if (!record(room) || typeof room.roomId !== "string" || !ROOM_ID.test(room.roomId) || !Array.isArray(room.refusals) || seen.has(room.roomId)) {
          throw new Error("Invalid engagement refusals store.");
        }
        seen.add(room.roomId);
        rooms.push({ roomId: room.roomId, refusals: room.refusals.map(loadRefusal) });
      }
      this.rooms = rooms;
    } catch (error) {
      // Missing means no refusals anywhere; any other failure refuses every change rather than overwrite a damaged store.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  list(roomId: string): EngagementRefusal[] {
    if (this.unreadable || typeof roomId !== "string") return [];
    const room = this.rooms.find((row) => row.roomId === roomId);
    return room ? room.refusals.map((refusal) => ({ ...refusal, hosts: [...refusal.hosts] })) : [];
  }

  /** Record a refusal, or bump the one for the same command and reason. Best-effort: a damaged store never blocks a command. */
  record(roomId: string, check: ScopeRefusal, command: string, at = Date.now()): void {
    if (this.unreadable || typeof roomId !== "string" || !ROOM_ID.test(roomId)) return;
    // The command is shown to a person, so a held secret in it is masked before it is written, as everywhere else.
    const scrubbed = scrubHeldSecrets(command);
    const next: EngagementRefusal = {
      id: this.newId(),
      command: scrubbed.length > MAX_COMMAND ? scrubbed.slice(0, MAX_COMMAND) : scrubbed,
      reason: check.reason,
      hosts: check.reason === "targets" ? [...check.hosts] : [],
      ...(check.reason === "window" ? { window: check.detail } : {}),
      attempts: 1,
      at,
    };
    const room = this.rooms.find((row) => row.roomId === roomId);
    const key = refusalKey(next);
    const existing = room?.refusals.find((refusal) => refusalKey(refusal) === key);
    if (existing) {
      const updated: EngagementRefusal = { ...existing, hosts: next.hosts, ...(next.window ? { window: next.window } : {}), attempts: existing.attempts + 1, at };
      this.save(this.withRoom(roomId, room!.refusals.map((refusal) => (refusal.id === existing.id ? updated : refusal))));
      return;
    }
    const kept = room?.refusals ?? [];
    // Over the cap the oldest goes, so a room under sustained probing keeps its most recent refusals rather than wedging.
    const trimmed = kept.length >= MAX_REFUSALS_PER_ROOM ? kept.slice(kept.length - MAX_REFUSALS_PER_ROOM + 1) : kept;
    this.save(this.withRoom(roomId, [...trimmed, next]));
  }

  private withRoom(roomId: string, refusals: EngagementRefusal[]): StoredRefusalsRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, refusals }];
  }

  private newId(): string {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private save(rooms: StoredRefusalsRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > REFUSALS_MAX_STORE_BYTES) return;
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}
