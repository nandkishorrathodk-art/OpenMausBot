// The agents catalog's engagement_finding tool: the ledger of what an engagement's team has found, validated and fixed,
// room-scoped. The internal route (server/routes/engagement-findings.ts) resolves the room from this conversation.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const ENGAGEMENT_FINDING_TOOL = "engagement_finding";

const MAX_EVIDENCE_IN_RESULT = 400;

interface WireFinding {
  id: string;
  target: string;
  title: string;
  severity: string;
  status: string;
  evidence: string;
  proof?: string;
  repro?: { kind: "http"; method: string; url: string; expect?: string };
  replay?: { at: number; ok: boolean; error?: string; excerpt?: string };
  detail?: string;
  reportedAt: number;
  updatedAt: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asFinding = (value: unknown): WireFinding | null =>
  record(value) && typeof value.id === "string" ? (value as unknown as WireFinding) : null;

function line(finding: WireFinding): string {
  const detail = finding.detail ? `\n    detail: ${finding.detail}` : "";
  return `- [${finding.id}] ${finding.severity}/${finding.status} — ${finding.target}: ${finding.title}${detail}`;
}

function one(finding: WireFinding): string {
  const evidence = finding.evidence.length > MAX_EVIDENCE_IN_RESULT
    ? `${finding.evidence.slice(0, MAX_EVIDENCE_IN_RESULT)}…`
    : finding.evidence;
  const proof = finding.proof ? `\nProof: ${finding.proof}` : "";
  const repro = finding.repro ? `\nRepro: ${finding.repro.method} ${finding.repro.url}${finding.repro.expect ? ` (expects: ${finding.repro.expect})` : ""}` : "";
  const replay = finding.replay
    ? `\nReplay: ${finding.replay.ok ? "held" : "failed"} at ${new Date(finding.replay.at).toISOString()}${finding.replay.error ? ` — ${finding.replay.error}` : ""}`
    : "";
  const detail = finding.detail ? `\nDetail: ${finding.detail}` : "";
  return `${finding.severity}/${finding.status} — ${finding.target}: ${finding.title}\nEvidence: ${evidence}${proof}${repro}${replay}${detail}`;
}

export async function callEngagementFindingTool(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  const action = String(args.action ?? "list");
  const { ok, body } = await context.client.apiResponse("/api/internal/findings", {
    method: "POST",
    body: JSON.stringify({
      action,
      ...(typeof args.id === "string" ? { id: args.id } : {}),
      ...(typeof args.target === "string" ? { target: args.target } : {}),
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.severity === "string" ? { severity: args.severity } : {}),
      ...(typeof args.status === "string" ? { status: args.status } : {}),
      ...(typeof args.evidence === "string" ? { evidence: args.evidence } : {}),
      ...(typeof args.proof === "string" ? { proof: args.proof } : {}),
      ...(args.repro !== undefined ? { repro: args.repro } : {}),
      ...(typeof args.detail === "string" ? { detail: args.detail } : {}),
    }),
  });
  if (!ok) return { text: String(body.error ?? "The findings ledger could not be read."), isError: true };
  if (action === "replay") {
    const replayed = asFinding(body.finding);
    if (!replayed) return { text: "The replay did not confirm the change.", isError: true };
    return { text: `${replayed.replay?.ok ? "The flaw reproduced again." : "The flaw did not reproduce."}\n${one(replayed)}`, isError: replayed.replay?.ok !== true };
  }
  if (action === "list") {
    const findings = Array.isArray(body.findings) ? body.findings.map(asFinding).filter((finding): finding is WireFinding => finding !== null) : [];
    if (!findings.length) {
      return { text: "No findings recorded for this engagement yet. Record one as soon as a flaw is suspected, with what shows it, then prove or dismiss it." };
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>;
    const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    return { text: `Findings for this engagement (${findings.length}):\n${sorted.map(line).join("\n")}` };
  }
  const finding = asFinding(body.finding);
  if (!finding) return { text: "The ledger did not confirm the change.", isError: true };
  return { text: action === "record" ? `Recorded.\n${one(finding)}` : `Updated.\n${one(finding)}` };
}

export const ENGAGEMENT_FINDING_TOOL_DEFINITION = {
  name: ENGAGEMENT_FINDING_TOOL,
  description:
    "The engagement's shared ledger of flaws, one per room, every member reads and writes it. action=record adds a flaw, or updates the one with the same target and title; update changes one by id (from a list) as its evidence or status moves on; list reads them all, worst first; replay re-runs a finding's repro and lets the server decide its status. Record a flaw as soon as you suspect it, with evidence: the command and its output, the request and its response, or the artifact that shows it. For a flaw one HTTP request shows, record repro and call action=replay: the server sends it, and only a passing replay makes the finding proven. Without a repro, keep status=suspected until you can prove it, then set status=proven with proof: the exact request and the response it returned, or the command and its output, short enough for the client to run again. The client acts on what is proven: never record a finding without the evidence that shows it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "record", "update", "replay"], description: "list reads the ledger; record adds or updates by target and title; update changes one by id; replay re-runs the repro the server can check." },
      id: { type: "string", description: "update and replay: the finding's id, from a list." },
      target: { type: "string", maxLength: 300, description: "record: the asset the flaw is in — a host, an endpoint, a path. update: leave out to keep it." },
      title: { type: "string", maxLength: 300, description: "record: what is wrong, one line. update: leave out to keep it." },
      severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "How bad if exploited. Defaults to medium." },
      status: { type: "string", enum: ["suspected", "proven", "fixed", "wont-fix"], description: "Defaults to suspected; proven once evidence shows it, or once a replay of its repro passes." },
      evidence: { type: "string", description: "record: what shows it — the command and its output, the request and its response, or the artifact path. Required." },
      proof: { type: "string", description: "The reproduction a person can run again: the exact request and the response it returned, or the command and its output. Required to set status=proven when the finding has no repro." },
      repro: {
        type: "object",
        description: "A reproduction the server can run itself: one HTTP request the flaw shows. Record it, then action=replay; the replay decides proven.",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["http"], description: "Only http is replayable." },
          method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], description: "The request's method." },
          url: { type: "string", maxLength: 2048, description: "Absolute http or https URL. Its host must be inside the engagement's scope." },
          headers: { type: "object", description: "Optional request headers, as name/value strings. Host, content-length and proxy headers are refused.", additionalProperties: { type: "string" } },
          body: { type: "string", description: "Optional request body, for POST, PUT, PATCH or DELETE." },
          expect: { type: "string", maxLength: 2000, description: "The text that must come back for the flaw to still be there. Without it the replay only records the answer." },
        },
        required: ["kind", "method", "url"],
      },
      detail: { type: "string", description: "Optional: impact and the steps to reproduce it." },
    },
    required: ["action"],
  },
};
