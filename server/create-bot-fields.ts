// create_bot's copyFromBotId: a Chief replacing a bot starts the new one from that bot's SOUL.md, role and model.
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import type { ModelSelection } from "./contracts.ts";
import { canManage, type RosterMember } from "./peer-roster.ts";
import { fitsOnOneLine } from "./bot-profile.ts";

export interface CopySource extends RosterMember {
  soul?: string;
  modelSelection: ModelSelection;
}

/** Matches the department name limit in routes/sidebar-sections.ts. */
export const MAX_SECTION_CHARS = 60;

export type CreateBotFields =
  | { name: string; role: string; instructions: string; soul: string; section?: string; modelSelection?: ModelSelection }
  | { status: number; error: string };

/** The internal create-bot request body: each tool argument is copied by hand, so a key missing here never reaches the server. */
export function createBotRequestBody(args: Record<string, unknown>, fromBotId: string, fromThreadId: string): Record<string, unknown> {
  const copyFrom = typeof args.copy_from_bot_id === "string" ? args.copy_from_bot_id.trim() : "";
  return {
    fromBotId,
    fromThreadId,
    name: String(args.name ?? "").trim(),
    role: String(args.role ?? "").trim(),
    instructions: String(args.instructions ?? "").trim(),
    ...(copyFrom ? { copyFromBotId: copyFrom } : {}),
    ...(args.modelSelection !== undefined ? { modelSelection: args.modelSelection } : {}),
    ...(typeof args.cwd === "string" ? { cwd: args.cwd.trim() } : {}),
    ...(typeof args.section === "string" ? { section: args.section.trim() } : {}),
  };
}

/** The new bot's name, role and soul; with copyFromBotId, a bot the Chief manages lends its soul, role and model. */
export function createBotFields(body: Record<string, unknown>, chief: RosterMember, bots: readonly CopySource[]): CreateBotFields {
  const name = String(body.name ?? "").trim();
  const role = String(body.role ?? "").trim();
  const instructions = String(body.instructions ?? "").trim();
  const section = typeof body.section === "string" ? body.section.trim() || undefined : undefined;
  if (section !== undefined && (section.length > MAX_SECTION_CHARS || !fitsOnOneLine(section))) {
    return { status: 400, error: `section must fit on one line of at most ${MAX_SECTION_CHARS} characters` };
  }
  if (body.copyFromBotId === undefined) return { name, role, instructions, soul: instructions, ...(section ? { section } : {}) };
  const id = typeof body.copyFromBotId === "string" ? body.copyFromBotId.trim() : "";
  const source = bots.find((bot) => bot.id === id);
  if (!source || !canManage(chief, source)) {
    return { status: 404, error: "copy_from_bot_id must be the exact id of a bot you look after; use list_bots" };
  }
  // Extra instructions come after the copied ones, so a handover note can add to them.
  const soul = [(source.soul ?? "").trim(), instructions].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(soul) > BOT_PROFILE_LIMITS.soul) {
    return { status: 400, error: `the copied instructions plus yours are over ${BOT_PROFILE_LIMITS.soul} bytes; shorten instructions` };
  }
  return { name, role: role || source.title?.trim() || "", instructions, soul, ...(section ? { section } : {}), modelSelection: source.modelSelection };
}
