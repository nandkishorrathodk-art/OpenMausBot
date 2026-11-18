import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { ASSET_KINDS, type AssetKind, type EngagementAsset } from "../shared/engagement.ts";
import { writeFileAtomic } from "./atomic.ts";

// What one engagement found inside its authorized scope: the hosts, services and endpoints that exist to be tested.
// The findings say what is wrong with them; this says what there is. A scan's raw output becomes this ledger by
// the bot recording each thing it turns up, so a later turn works from what the team has, not from memory.
// Room-scoped like the scope and the findings, and never a place a command runs from.

export { ASSET_KINDS };
export type { AssetKind, EngagementAsset };

export type ParsedAsset =
  | { ok: true; asset: Omit<EngagementAsset, "id" | "firstSeenAt" | "lastSeenAt"> }
  | { ok: false; error: string };

const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS_PER_ROOM = 1000;
const MAX_LOCATION = 500;
const MAX_SERVICE = 200;
const MAX_BANNER = 2000;
const MAX_DISCOVERED = 1000;
const MAX_NOTES = 4000;
const ROOM_ID = /^[\w-]{1,128}$/;
const FILE_VERSION = 1;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): Error => Object.assign(new Error(message), { status: 400 });

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

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

interface StoredRoom {
  roomId: string;
  assets: EngagementAsset[];
}

function validateRoomId(roomId: string): void {
  if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) throw invalid("A valid room id is required.");
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
  private rooms: StoredRoom[] = [];
  private unreadable = false;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error("Invalid engagement assets store.");
      const saved: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!record(saved) || saved.version !== FILE_VERSION || !Array.isArray(saved.rooms) ||
        Object.keys(saved).some((key) => key !== "version" && key !== "rooms")) throw new Error("Invalid engagement assets store.");
      const rooms: StoredRoom[] = [];
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

  private withRoom(roomId: string, assets: EngagementAsset[]): StoredRoom[] {
    return [...this.rooms.filter((row) => row.roomId !== roomId), { roomId, assets }];
  }

  private newId(): string {
    return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private assertWritable(): void {
    if (this.unreadable) throw Object.assign(new Error("Engagement assets could not be read. Repair the store before changing them."), { status: 503 });
  }

  private save(rooms: StoredRoom[]): void {
    const json = JSON.stringify({ version: FILE_VERSION, rooms }, null, 2);
    if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw invalid("The engagement assets exceed the storage limit.");
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filename, json, { mode: 0o600 });
    this.rooms = rooms;
  }
}
