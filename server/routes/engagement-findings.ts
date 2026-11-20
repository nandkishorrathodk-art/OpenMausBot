// The internal calls behind the agents server's engagement_finding tool: the ledger of what an engagement's team has
// found, validated and fixed. Runs inside index.ts's /api/internal/ block, after the capability bearer is checked; the
// room is resolved from the caller's own conversation, never from the body, so a bot records only where it speaks.
import type { ServerResponse } from "node:http";

import type { EngagementFindingsStore } from "../engagement.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { GroupRecord } from "../store.ts";
import { PASS } from "./table.ts";
import { replayProof } from "../engagement-replay.ts";
import type { EngagementScope } from "../../shared/engagement.ts";

export interface EngagementFindingInternalDeps {
  findings: Pick<EngagementFindingsStore, "list" | "record" | "patch" | "recordReplay">;
  /** The room a conversation answers to, or null outside one. */
  roomOf(botId: string, threadId: string): GroupRecord | null;
  /** The room's authorization: a replay never leaves it. */
  scopeOf(roomId: string): EngagementScope | null;
  /** Runs a reproduction; injected so a test replays against its own fixture. */
  replay?: typeof replayProof;
}

export interface EngagementFindingInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export const FINDINGS_PATH = "/api/internal/findings";
const ACTIONS = new Set(["list", "record", "update", "replay"]);

export function createEngagementFindingInternalRoutes(deps: EngagementFindingInternalDeps) {
  return async (ctx: EngagementFindingInternalContext): Promise<typeof PASS | void> => {
    if (ctx.path !== FINDINGS_PATH || ctx.method !== "POST") return PASS;
    const body = await ctx.readBody();
    const action = (body as { action?: unknown } | null)?.action ?? "list";
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      return ctx.json(ctx.res, 400, { error: "action must be list, record or update." });
    }
    const room = deps.roomOf(ctx.botId, ctx.threadId);
    if (!room) {
      return ctx.json(ctx.res, 409, { error: "Findings live in an engagement room. This conversation is not in one." });
    }
    if (room.dm) {
      return ctx.json(ctx.res, 409, { error: "Findings live in an engagement room. A direct message holds none." });
    }
    try {
      if (action === "list") return ctx.json(ctx.res, 200, { findings: deps.findings.list(room.id) });
      if (action === "record") return ctx.json(ctx.res, 200, { finding: deps.findings.record(room.id, body) });
      const id = (body as { id?: unknown }).id;
      if (typeof id !== "string" || !id) return ctx.json(ctx.res, 400, { error: "update needs the finding's id, from the list." });
      if (action === "replay") {
        const current = deps.findings.list(room.id).find((finding) => finding.id === id);
        if (!current) return ctx.json(ctx.res, 404, { error: "No such finding in this engagement." });
        if (!current.repro) {
          return ctx.json(ctx.res, 400, { error: "This finding carries no replayable repro. Record one as an http proof, or keep its status suspected." });
        }
        const run = deps.replay ?? replayProof;
        const result = await run(current.repro, deps.scopeOf(room.id));
        return ctx.json(ctx.res, 200, { finding: deps.findings.recordReplay(room.id, id, result), replay: result });
      }
      return ctx.json(ctx.res, 200, { finding: deps.findings.patch(room.id, id, body) });
    } catch (error) {
      return ctx.json(ctx.res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : "invalid finding" });
    }
  };
}
