import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type EngagementFinding,
  type FindingSeverity,
  type FindingStatus,
} from "../shared/engagement.ts";
import { writeFileAtomic } from "./atomic.ts";

// The flaws one engagement has found, as the team recorded them: an asset, what is wrong, how bad, and what
// proves it. A finding is a claim until evidence is attached, which is what separates this ledger from a
// scanner's raw output. Room-scoped like the scope, and never a place a command runs from.

export { FINDING_SEVERITIES, FINDING_STATUSES };
export type { EngagementFinding, FindingSeverity, FindingStatus };

export type ParsedFinding =
  | { ok: true; finding: Omit<EngagementFinding, "id" | "reportedAt" | "updatedAt"> }
  | { ok: false; error: string };

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS_PER_ROOM = 500;
const MAX_TEXT = 4000;
const MAX_TITLE = 300;
const MAX_TARGET = 300;
const MAX_EVIDENCE = 8000;
const ROOM_ID = /^[\w-]{1,128}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): Error => Object.assign(new Error(message), { status: 400 });

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** What a bot or the person sends. The store stamps the id and the times. */
export function parseFinding(value: unknown): ParsedFinding {
  if (!record(value)) return { ok: false, error: "A finding must be an object." };
  const target = text(value.target);
  if (!target) return { ok: false, error: "A finding needs a target: the host, endpoint or path it is in." };
  if (target.length > MAX_TARGET) return { ok: false, error: `The target must be at most ${MAX_TARGET} characters.` };
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
      ...(detail ? { detail } : {}),
    },
  };
}

/** Two findings with the same target and title, ignoring case and surrounding space, are the same finding. */
export function findingKey(target: string, title: string): string {
  return `${target.trim().toLowerCase()}\u0000${title.trim().toLowerCase()}`;
}

interface StoredRoom {
  roomId: string;
  findings: EngagementFinding[];
}

const FILE_VERSION = 1;

function validateRoomId(roomId: string): void {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) throw invalid("A valid room id is required.");
}

function loadFinding(row: unknown): EngagementFinding {
  if (!record(row) || typeof row.id !== "string" || typeof row.reportedAt !== "number" || typeof row.updatedAt !== "number") {
    throw new Error("Invalid engagement findings store.");
  }
  const parsed = parseFinding(row);
  if (!parsed.ok) throw new Error("Invalid engagement findings store.");
  return { id: row.id, reportedAt: row.reportedAt, updatedAt: row.updatedAt, ...parsed.finding };
}

/** The findings of every engagement, apart from the room records so a room's own history cannot rewrite them. */
export class EngagementFindingsStore {
  private rooms: StoredRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid engagement findings store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement findings store.");
      const rooms: StoredRoom[] = [];
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

  private withRoom(roomId: string, findings: EngagementFinding[]): StoredRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, findings }];
  }

  private newId(): string {
    return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Engagement findings could not be read. Repair the store before changing them."), { status: 503 });
  }

  private save(rooms: StoredRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw invalid("The engagement findings exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}
