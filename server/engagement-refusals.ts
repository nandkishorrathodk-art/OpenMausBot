import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EngagementRefusal } from "../shared/engagement.ts";
import { scrubHeldSecrets } from "../shared/redact.ts";
import type { ScopeRefusal } from "./engagement-scope.ts";
import { writeFileAtomic } from "./atomic.ts";

// The commands one engagement's scope refused before they ran, as the team reached for them. A refusal is the other
// half of the ledger: the findings say what the team proved inside the scope, and this says what it reached for
// outside it. Room-scoped like the scope and the findings, and never a place a command runs from.

export type { EngagementRefusal };

const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_REFUSALS_PER_ROOM = 200;
const MAX_COMMAND = 2000;
const ROOM_ID = /^[\w-]{1,128}$/;
const FILE_VERSION = 1;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface StoredRoom {
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
  private rooms: StoredRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid engagement refusals store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement refusals store.");
      const rooms: StoredRoom[] = [];
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

  private withRoom(roomId: string, refusals: EngagementRefusal[]): StoredRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, refusals }];
  }

  private newId(): string {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private save(rooms: StoredRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) return;
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}
