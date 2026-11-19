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
  const detail = finding.detail ? `\nDetail: ${finding.detail}` : "";
  return `${finding.severity}/${finding.status} — ${finding.target}: ${finding.title}\nEvidence: ${evidence}${proof}${detail}`;
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
      ...(typeof args.detail === "string" ? { detail: args.detail } : {}),
    }),
  });
  if (!ok) return { text: String(body.error ?? "The findings ledger could not be read."), isError: true };
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
    "The engagement's shared ledger of flaws, one per room, every member reads and writes it. action=record adds a flaw, or updates the one with the same target and title; update changes one by id (from a list) as its evidence or status moves on; list reads them all, worst first. Record a flaw as soon as you suspect it, with evidence: the command and its output, the request and its response, or the artifact that shows it. Keep status=suspected until you can prove it, then set status=proven with proof: the exact request and the response it returned, or the command and its output, short enough for the client to run again. The client acts on what is proven. A finding is not a claim: never record one without the evidence that shows it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "record", "update"], description: "list reads the ledger; record adds or updates by target and title; update changes one by id." },
      id: { type: "string", description: "update: the finding's id, from a list." },
      target: { type: "string", maxLength: 300, description: "record: the asset the flaw is in — a host, an endpoint, a path. update: leave out to keep it." },
      title: { type: "string", maxLength: 300, description: "record: what is wrong, one line. update: leave out to keep it." },
      severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "How bad if exploited. Defaults to medium." },
      status: { type: "string", enum: ["suspected", "proven", "fixed", "wont-fix"], description: "Defaults to suspected; proven once evidence shows it." },
      evidence: { type: "string", description: "record: what shows it — the command and its output, the request and its response, or the artifact path. Required." },
      proof: { type: "string", description: "The reproduction a person can run again: the exact request and the response it returned, or the command and its output. Required to set status=proven." },
      detail: { type: "string", description: "Optional: impact and the steps to reproduce it." },
    },
    required: ["action"],
  },
};
