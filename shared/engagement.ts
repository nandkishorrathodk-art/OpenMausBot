/**
 * An engagement's two room-scoped records: the scope the client authorized,
 * and the flaws the team found under it. The server owns both
 * (server/engagement-scope.ts, server/engagement-findings.ts); a client reads
 * and writes them through the room's own routes.
 */

/** What the client authorized: a host, `*.example.com`, an IPv4 address or a CIDR block. */
export interface EngagementScope {
  targets: string[];
  /** What the client put off-limits, matched the same way. It beats `targets`. */
  offLimits: string[];
  /** Epoch ms. Absent means the authorization has no start. */
  startsAt?: number;
  /** Epoch ms. Absent means the authorization has no end. */
  endsAt?: number;
}

/** GET/PUT /api/groups/:id/scope. A null scope means the room has none. */
export interface RoomScopeResponse {
  scope: EngagementScope | null;
}

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const FINDING_STATUSES = ["suspected", "proven", "fixed", "wont-fix"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const PROOF_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type ProofHttpMethod = (typeof PROOF_HTTP_METHODS)[number];

/**
 * A reproduction the server runs itself: one request the client's asset
 * answers. A `proven` finding carries one and the replay result, so the label
 * means the product re-ran it, not that the agent said so.
 *
 * Only HTTP is replayable. Running a bot-written shell command from the server
 * would put arbitrary code in the host process; a command-shaped proof stays
 * narrative `proof` text until a sandboxed runner exists.
 */
export interface EngagementProof {
  kind: "http";
  method: ProofHttpMethod;
  /** Absolute `http`/`https` URL. Its host must be inside the room's scope. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** A text the response must contain for the flaw to still be there: the payload echoed back, the
   * error text, the leaked record. Absent means the replay only records what the target answered. */
  expect?: string;
}

/** What a replay found. Stored on the finding, so a reader sees when it last held and what came back. */
export interface ProofReplay {
  at: number;
  ok: boolean;
  /** Why it did not hold: the target refused, timed out, or the expected text was gone. */
  error?: string;
  /** A short excerpt of what the target answered, for the report. */
  excerpt?: string;
}

/** One flaw as the team recorded it: an asset, what is wrong, how bad, and what proves it. */
export interface EngagementFinding {
  id: string;
  /** The asset the flaw is in: a host, an endpoint, a path. */
  target: string;
  /** What is wrong, one line. Two findings with the same target and title are the same finding. */
  title: string;
  severity: FindingSeverity;
  /** `suspected` until evidence proves it; `proven` is what the client can act on. */
  status: FindingStatus;
  /** How it was shown: the command and its output, a request and its response, an artifact path. */
  evidence: string;
  /** What makes `proven` true: the reproduction that a person can run again, kept apart from the narrative
   * `evidence` so a claim cannot borrow a proven label from prose. Required while `status` is `proven`. */
  proof?: string;
  /** The machine-runnable reproduction. When present, the server replays it and records the result in
   * `replay`; `proven` then means the product re-ran it, not that the agent said so. */
  repro?: EngagementProof;
  /** The most recent replay of `repro`, written by the server. A failed replay demotes the finding to
   * `suspected`, so a label cannot outlive the flaw it described. */
  replay?: ProofReplay;
  detail?: string;
  reportedAt: number;
  updatedAt: number;
}

/** GET /api/groups/:id/findings. */
export interface RoomFindingsResponse {
  findings: EngagementFinding[];
}

export const ASSET_KINDS = ["host", "service", "web-app", "endpoint", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** One thing the engagement found in the authorized scope: the attack surface it discovered before testing it.
 * The findings say what is wrong; this says what exists to be wrong. */
export interface EngagementAsset {
  id: string;
  /** Where it is: a host, `host:port`, or a URL. Two assets at the same location are the same asset. */
  location: string;
  kind: AssetKind;
  /** The product and version it runs, when they are known: `nginx 1.25.3`, `OpenSSH 9.6`. */
  service?: string;
  /** The fingerprint that identified it: a banner, an HTTP title, a certificate subject. */
  banner?: string;
  /** How it was found: the command, scan or source that turned it up. */
  discoveredBy: string;
  notes?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** GET /api/groups/:id/assets. `inScope` is read against the room's current scope, not stored. */
export interface RoomAssetsResponse {
  assets: Array<EngagementAsset & { inScope: boolean }>;
}

/** One command an engagement's scope refused before it ran: the record of what the team reached for. */
export interface EngagementRefusal {
  id: string;
  /** The command as the operator sent it. */
  command: string;
  reason: "targets" | "window";
  /** The hosts outside the scope the command reached for; empty for a window refusal. */
  hosts: string[];
  /** For a window refusal: which side of the window. */
  window?: "not started" | "ended";
  /** How many times this same command was refused. */
  attempts: number;
  /** Epoch ms of the most recent refusal. */
  at: number;
}

/** GET /api/groups/:id/refusals. */
export interface RoomRefusalsResponse {
  refusals: EngagementRefusal[];
}

/**
 * The client-facing report of an engagement: what the team was authorized to
 * test, and what it found under that authorization. A pure rendering of the
 * room's scope and findings, so the server hands it over as a file and the
 * findings page shows the same words. English only, like the transcript export:
 * the report is a document the client keeps, not UI copy.
 */

export interface EngagementReportInput {
  /** The room the engagement ran in. */
  room: string;
  scope: EngagementScope | null;
  findings: readonly EngagementFinding[];
  generatedAt?: Date;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const STATUS_WORD: Record<FindingStatus, string> = {
  suspected: "Suspected",
  proven: "Proven",
  fixed: "Fixed",
  "wont-fix": "Won't fix",
};
const SEVERITY_WORD: Record<FindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** One line of a heading, a bullet or a table cell: newlines collapse, and only the two marks that break the
 * structure here — the table's `|` and the code span's backtick — are escaped. A host keeps its `*`. */
function line(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([|`])/g, "\\$1");
}

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function window(scope: EngagementScope | null): string {
  if (!scope) return "No scope was set for this room.";
  const from = scope.startsAt === undefined ? "open" : when(scope.startsAt);
  const to = scope.endsAt === undefined ? "open" : when(scope.endsAt);
  return `${from} → ${to}`;
}

/**
 * The report, worst finding first. `proven` findings are what the client can act
 * on and are counted apart from `suspected` ones, so a reader never mistakes an
 * unverified lead for a finding. A room with no findings still reports its scope,
 * so the document says what was authorized even when nothing was found.
 */
export function buildEngagementReport(input: EngagementReportInput): string {
  const { room, scope, findings } = input;
  const generated = input.generatedAt ?? new Date();
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.reportedAt - a.reportedAt,
  );
  const proven = sorted.filter((f) => f.status === "proven").length;
  const suspected = sorted.filter((f) => f.status === "suspected").length;

  const out: string[] = [
    `# Engagement report — ${line(room)}`,
    "",
    `Generated ${when(generated.getTime())}`,
    "",
    "## Scope",
    "",
    "- Authorized targets: " + (scope && scope.targets.length ? scope.targets.map(line).join(", ") : "none"),
    "- Off-limits: " + (scope && scope.offLimits.length ? scope.offLimits.map(line).join(", ") : "none"),
    `- Window: ${window(scope)}`,
    "",
    "## Summary",
    "",
    `- Findings: ${sorted.length}`,
    `- Proven: ${proven}`,
    `- Suspected: ${suspected}`,
  ];

  const bySeverity = FINDING_SEVERITIES.map((severity) => {
    const count = sorted.filter((f) => f.severity === severity).length;
    return count > 0 ? `${SEVERITY_WORD[severity]} ${count}` : "";
  }).filter(Boolean);
  out.push(`- By severity: ${bySeverity.length ? bySeverity.join(", ") : "none"}`, "");

  if (!sorted.length) {
    out.push("No findings were recorded under this scope.", "");
    return out.join("\n");
  }

  out.push(
    "## Findings",
    "",
    "| Severity | Status | Target | Title |",
    "| --- | --- | --- | --- |",
    ...sorted.map((f) => `| ${SEVERITY_WORD[f.severity]} | ${STATUS_WORD[f.status]} | ${line(f.target)} | ${line(f.title)} |`),
    "",
  );

  for (const finding of sorted) {
    out.push(
      `### ${SEVERITY_WORD[finding.severity]} — ${line(finding.title)}`,
      "",
      `- Target: \`${line(finding.target)}\``,
      `- Status: ${STATUS_WORD[finding.status]}`,
      `- Reported: ${when(finding.reportedAt)}`,
    );
    if (finding.updatedAt > finding.reportedAt) out.push(`- Updated: ${when(finding.updatedAt)}`);
    if (finding.repro) out.push(`- Replay: \`${finding.repro.method} ${line(finding.repro.url)}\``);
    if (finding.replay) {
      out.push(finding.replay.ok
        ? `- Replayed: ${when(finding.replay.at)} — the flaw reproduced again`
        : `- Replayed: ${when(finding.replay.at)} — did not reproduce${finding.replay.error ? `: ${line(finding.replay.error)}` : ""}`);
    }
    out.push("", "**Evidence**", "", finding.evidence.trim(), "");
    if (finding.proof?.trim()) out.push("**Proof**", "", finding.proof.trim(), "");
    if (finding.replay?.excerpt?.trim()) out.push("**What the target answered**", "", "```", finding.replay.excerpt.trim(), "```", "");
    if (finding.detail?.trim()) out.push("**Detail**", "", finding.detail.trim(), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** `acme-engagement-report-2026-11-15.md`, from the room's name. */
export function engagementReportFilename(room: string, date = new Date()): string {
  const base =
    room.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 120).replace(/^-|-$/g, "") || "engagement";
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")];
  return `${base}-report-${day.join("-")}.md`;
}
