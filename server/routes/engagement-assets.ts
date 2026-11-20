// The internal calls behind the agents server's engagement_asset tool: the inventory of what an engagement's team has
// found inside its scope. Runs inside index.ts's /api/internal/ block, after the capability bearer is checked; the
// room is resolved from the caller's own conversation, never from the body, so a bot records only where it speaks.
import type { ServerResponse } from "node:http";

import type { EngagementAssetsStore } from "../engagement.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { GroupRecord } from "../store.ts";
import { PASS } from "./table.ts";

export interface EngagementAssetInternalDeps {
  assets: Pick<EngagementAssetsStore, "list" | "record" | "patch">;
  /** The room a conversation answers to, or null outside one. */
  roomOf(botId: string, threadId: string): GroupRecord | null;
}

export interface EngagementAssetInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export const ASSETS_PATH = "/api/internal/assets";
const ACTIONS = new Set(["list", "record", "update"]);

export function createEngagementAssetInternalRoutes(deps: EngagementAssetInternalDeps) {
  return async (ctx: EngagementAssetInternalContext): Promise<typeof PASS | void> => {
    if (ctx.path !== ASSETS_PATH || ctx.method !== "POST") return PASS;
    const body = await ctx.readBody();
    const action = (body as { action?: unknown } | null)?.action ?? "list";
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      return ctx.json(ctx.res, 400, { error: "action must be list, record or update." });
    }
    const room = deps.roomOf(ctx.botId, ctx.threadId);
    if (!room) {
      return ctx.json(ctx.res, 409, { error: "Assets live in an engagement room. This conversation is not in one." });
    }
    if (room.dm) {
      return ctx.json(ctx.res, 409, { error: "Assets live in an engagement room. A direct message holds none." });
    }
    try {
      if (action === "list") return ctx.json(ctx.res, 200, { assets: deps.assets.list(room.id) });
      if (action === "record") return ctx.json(ctx.res, 200, { asset: deps.assets.record(room.id, body) });
      const id = (body as { id?: unknown }).id;
      if (typeof id !== "string" || !id) return ctx.json(ctx.res, 400, { error: "update needs the asset's id, from the list." });
      return ctx.json(ctx.res, 200, { asset: deps.assets.patch(room.id, id, body) });
    } catch (error) {
      return ctx.json(ctx.res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : "invalid asset" });
    }
  };
}
