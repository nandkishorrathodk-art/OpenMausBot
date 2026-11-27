// Pins the bytes of Parth Lab's own prompt text a turn carries: the fixed sections of a bot's system prompt, what a
// Claude turn appends with --append-system-prompt-file, and what a Codex turn sets as developer instructions. Each may
// move at most 2% either way (lower a number to lock in a win); a bigger change moves its baseline by hand.
import { describe, expect, it } from "vitest";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { codexDeveloperInstructions, syncCodexInstructions } from "./drivers/codex-instructions.ts";
import { volatileContextNote, withVolatileNote } from "./drivers/prompt-split.ts";
import { meetingsUnavailablePrompt } from "./meetings/prompt.ts";
import { replyHabitsPrompt } from "./reply-habits.ts";
import { setupSystemPrompt } from "./setup-mode.ts";
import { computerSelectionPrompt } from "./surface.ts";
import { memoryRulesPrompt, workspaceDir } from "./workspace.ts";
import {
  AGENTS_TOOL_BRIDGE_PROMPT, CREDENTIAL_PROMPT, PROFILE_PROMPT, SIGN_IN_PROMPT, TEAM_MEMORY_PROMPT, TRIGGER_PROMPT, botPersona, buildSystemPrompt,
  computerPrompt, longCommandsPrompt, type ComputerPromptKind, type PromptPart,
} from "./system-prompt.ts";

const BOT = { id: "bot-budget", name: "Kiwi" };

/** The fixed parts every direct chat with the agents tools carries, in the order the harness builds them. */
function directChatParts(setup: boolean): PromptPart[] {
  return [
    { id: "setup", label: "Setup", text: setupSystemPrompt(setup, { skills: true, connectedApps: { state: "available" } }) },
    { id: "meetings", label: "Meetings", text: meetingsUnavailablePrompt({ agentsTools: true, cloudComputer: false }) },
    // Both used to ride the volatile note; they are the same every turn, so the stable half carries them now.
    { id: "computer-selection", label: "Choosing a computer", text: computerSelectionPrompt() },
    { id: "credential", label: "Credentials", text: CREDENTIAL_PROMPT },
    { id: "routine", label: "Triggers", text: TRIGGER_PROMPT },
    { id: "profile", label: "Profile changes", text: PROFILE_PROMPT },
    { id: "team-memory", label: "Team memory", text: TEAM_MEMORY_PROMPT },
  ];
}

const KINDS: ComputerPromptKind[] = ["vm-private", "vm-shared", "box", "vps", "local"];

async function measured(): Promise<Record<string, number>> {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  // A direct chat has the agents tools, so its reply habits carry the publishing sentence.
  const chat = buildSystemPrompt(botPersona(BOT), "", directChatParts(false), { env: {} });
  const setup = buildSystemPrompt(botPersona(BOT), "", directChatParts(true), { env: {} });
  const chief = chiefOfStaffSystemPrompt(BOT.id, [{ ...BOT, chiefOfStaff: true }] as never, true, undefined, [] as never);
  let resumed = "";
  await syncCodexInstructions("budget", "native-budget", chat.stable, "", true, async (_method, params) => {
    resumed = (params as { items: Array<{ content: Array<{ text: string }> }> }).items[0]!.content[0]!.text;
    return {};
  });
  return {
    "reply-habits": bytes(replyHabitsPrompt(true)),
    "tool-bridge": bytes(AGENTS_TOOL_BRIDGE_PROMPT),
    "sign-in": bytes(SIGN_IN_PROMPT),
    "chief-of-staff": bytes(chief),
    // The bot's own memory paths vary with the data folder, so they count as empty strings here.
    "memory-rules": bytes(memoryRulesPrompt(BOT.id, { managedWrites: true }).replaceAll(JSON.stringify(workspaceDir(BOT.id)).slice(0, -1), "\"")),
    ...Object.fromEntries(directChatParts(true).map((part) => [part.id, bytes(part.text)])),
    ...Object.fromEntries(KINDS.map((kind) => [`computer:${kind}`, bytes(computerPrompt(kind) + longCommandsPrompt(kind))])),
    "claude:direct-chat": bytes(chat.stable),
    "claude:setup-chat": bytes(setup.stable),
    "claude:volatile-note": bytes(withVolatileNote("", "x", true)) - 1,
    "codex:direct-chat": bytes(codexDeveloperInstructions({}, chat.stable)),
    "codex:setup-chat": bytes(codexDeveloperInstructions({}, setup.stable)),
    "codex:resumed-instructions": bytes(resumed) - bytes(chat.stable),
    "codex:volatile-note": bytes(volatileContextNote("x", false)) - 1,
  };
}

/** Bytes when the budget was last set; the test allows at most 2% either way. */
const PROMPT_BUDGET_BASELINE: Record<string, number> = {
  "reply-habits": 3084,
  "tool-bridge": 591,
  "sign-in": 2584,
  "chief-of-staff": 6367,
  "memory-rules": 2246,
  "setup": 2584,
  "meetings": 296,
  "computer-selection": 1267,
  "credential": 1045,
  "routine": 2683,
  "profile": 1034,
  "team-memory": 286,
  // Both sandbox kinds carry +130 bytes on purpose: the person's own files (C:\Users\…, /Users/…, Desktop) are reached only on This computer.
  "computer:vm-private": 6304,
  "computer:vm-shared": 6263,
  "computer:box": 4731,
  "computer:vps": 5405,
  "computer:local": 5644,
  "claude:direct-chat": 12886,
  "claude:setup-chat": 15470,
  "claude:volatile-note": 178,
  "codex:direct-chat": 12886,
  "codex:setup-chat": 15470,
  "codex:resumed-instructions": 211,
  "codex:volatile-note": 95,
};

describe("Parth Lab's prompt text per turn", () => {
  it("stays within its pinned budget", async () => {
    const now = await measured();
    expect(Object.keys(now).sort()).toEqual(Object.keys(PROMPT_BUDGET_BASELINE).sort());
    for (const [name, baseline] of Object.entries(PROMPT_BUDGET_BASELINE)) {
      const ratio = now[name]! / baseline;
      expect(ratio, `${name}: ${now[name]} bytes against ${baseline}`).toBeGreaterThanOrEqual(0.98);
      expect(ratio, `${name}: ${now[name]} bytes against ${baseline}`).toBeLessThanOrEqual(1.02);
    }
  });
});
