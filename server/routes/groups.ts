import type { RoomCreateResponse, RoomUpdateResponse, WireGroup } from "../../shared/wire.ts";
import { buildEngagementReport, engagementReportFilename } from "../../shared/engagement-report.ts";
import type { EngagementScope } from "../engagement-scope.ts";
import type { EngagementFinding } from "../engagement-findings.ts";
import type { EngagementAsset } from "../engagement-assets.ts";
import type { EngagementRefusal } from "../engagement-refusals.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupDefaultResponder, GroupRecord, Store } from "../store.ts";
import type { ThreadStarters } from "../thread-starters.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GroupRouteDeps {
  store: Pick<Store, "bot" | "group" | "messagesFor" | "patchGroup">;
  cloudHome: boolean;
  /** A member may only put bots they can see in a room. */
  visibleFor(auth: RequestAuth): VisibleSet;
  actorKey(auth: RequestAuth & { kind: "session" }): string;
  threadStarters: Pick<ThreadStarters, "set">;
  createChannel(value: unknown): GroupRecord;
  publicGroupState(record: GroupRecord): WireGroup;
  /** A room as this person has read it (a Team Cloud); the room itself anywhere else. */
  groupFor?(auth: RequestAuth, group: WireGroup): WireGroup;
  /** The engagement's authorized targets; null when the room has none. Only the person who holds the
   * authorization may set it, so no bot's tool can widen the scope it is then checked against. */
  scope: { get(roomId: string): EngagementScope | null; set(roomId: string, value: unknown): EngagementScope | null };
  /** Whether this caller is a person who may set a room's engagement scope, never a bot's shell. */
  canManageScope(auth: RequestAuth): boolean;
  /** The flaws the engagement has recorded, for the room panel to show. */
  findings: { list(roomId: string): EngagementFinding[] };
  /** What the engagement has found inside its scope, for the room panel to show. */
  assets: { list(roomId: string): EngagementAsset[] };
  /** Whether a location is inside a room's authorized scope, so the panel can flag an asset outside it. */
  assetInScope(roomId: string, location: string): boolean;
  /** The commands the engagement's scope refused, for the room panel to show. */
  refusals: { list(roomId: string): EngagementRefusal[] };
}

/** A room's default responder from a request body; null when it is not one, or names a bot outside the room. */
export function checkedGroupResponder(value: unknown, memberIds: string[]): GroupDefaultResponder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const responder = value as { kind?: unknown; botId?: unknown; fallbackBotId?: unknown };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "mentions") return { kind: "mentions" };
  if (responder.kind === "auto") {
    if (responder.fallbackBotId === undefined || responder.fallbackBotId === null) return { kind: "auto" };
    return typeof responder.fallbackBotId === "string" && memberIds.includes(responder.fallbackBotId)
      ? { kind: "auto", fallbackBotId: responder.fallbackBotId }
      : null;
  }
  if (
    responder.kind === "member" &&
    typeof responder.botId === "string" &&
    memberIds.includes(responder.botId)
  ) {
    return { kind: "member", botId: responder.botId };
  }
  return null;
}

export function createGroupRoutes(deps: GroupRouteDeps): RouteHandler {
  const { store, actorKey, threadStarters, createChannel, publicGroupState } = deps;
  const CLOUD_HOME = deps.cloudHome;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const visible = deps.visibleFor(auth);
    const own = (group: WireGroup) => deps.groupFor?.(auth, group) ?? group;
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const hiddenMember = Array.isArray(body?.memberIds) ? body.memberIds.find((id: unknown) => typeof id === "string" && store.bot(id) && !visible.bot(id)) : undefined;
      if (hiddenMember) return json(res, 400, { error: `unknown channel member: ${String(hiddenMember)}` });
      const group = createChannel(body);
      // On a Cloud home whoever opens a room names it (cloudThreadRefusal).
      if (CLOUD_HOME && auth.kind === "session") threadStarters.set(group.threadId, actorKey(auth));
      return json(res, 201, { group: { ...own(publicGroupState(group)), messages: [] } } satisfies RoomCreateResponse);
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/setup$/);
    if (m && method === "PATCH") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not have room setup" });
      const body = await readBody(req);
      if (body.action !== "complete" && body.action !== "skip") {
        return json(res, 400, { error: "action must be complete or skip" });
      }
      if (group.setupCompletedAt != null || group.setupSkippedAt != null) {
        return json(res, 200, { group: own(publicGroupState(group)) } satisfies RoomUpdateResponse);
      }
      if (store.messagesFor(group.threadId).length > 0) {
        return json(res, 409, { error: "room setup must be finished before the first message" });
      }

      const patch: Partial<Pick<GroupRecord, "cwd" | "defaultResponder" | "bulletin" | "setupCompletedAt" | "setupSkippedAt">> = {};
      if (body.action === "complete") {
        const checked = validateBotCwd(body.cwd ?? null);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        const responder = checkedGroupResponder(body.defaultResponder, group.memberIds);
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.cwd = checked.cwd ?? undefined;
        patch.defaultResponder = responder;
        patch.bulletin = body.bulletin;
        patch.setupCompletedAt = Date.now();
      } else {
        patch.setupSkippedAt = Date.now();
      }
      const updated = store.patchGroup(m[1], patch);
      if (!updated) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: own(publicGroupState(updated)) } satisfies RoomUpdateResponse);
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/scope$/);
    if (m && (method === "GET" || method === "PUT")) {
      if (!deps.canManageScope(auth)) return json(res, 403, { error: "Only the owner or an admin can set an engagement scope." });
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not hold an engagement scope" });
      if (method === "GET") return json(res, 200, { scope: deps.scope.get(group.id) });
      const body = await readBody(req);
      try {
        return json(res, 200, { scope: deps.scope.set(group.id, body?.scope ?? null) });
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : "invalid engagement scope" });
      }
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/findings$/);
    if (m && method === "GET") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not hold engagement findings" });
      if (!visible.group(group.id)) return json(res, 403, { error: "This room's findings are not yours to read." });
      return json(res, 200, { findings: deps.findings.list(group.id) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/assets$/);
    if (m && method === "GET") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not hold engagement assets" });
      if (!visible.group(group.id)) return json(res, 403, { error: "This room's assets are not yours to read." });
      return json(res, 200, { assets: deps.assets.list(group.id).map((asset) => ({ ...asset, inScope: deps.assetInScope(group.id, asset.location) })) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/refusals$/);
    if (m && method === "GET") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not hold engagement refusals" });
      if (!visible.group(group.id)) return json(res, 403, { error: "This room's refusals are not yours to read." });
      return json(res, 200, { refusals: deps.refusals.list(group.id) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/report$/);
    if (m && method === "GET") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not hold engagement findings" });
      if (!visible.group(group.id)) return json(res, 403, { error: "This room's findings are not yours to read." });
      const markdown = buildEngagementReport({ room: group.name, scope: deps.scope.get(group.id), findings: deps.findings.list(group.id) });
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${engagementReportFilename(group.name)}"`,
      });
      res.end(markdown);
      return;
    }
    return PASS;
  };
}
