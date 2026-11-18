/**
 * The client-facing report of an engagement: what the team was authorized to
 * test, and what it found under that authorization. A pure rendering of the
 * room's scope and findings, so the server hands it over as a file and the
 * findings page shows the same words. English only, like the transcript export:
 * the report is a document the client keeps, not UI copy.
 */
import {
  FINDING_SEVERITIES,
  type EngagementFinding,
  type EngagementScope,
  type FindingSeverity,
  type FindingStatus,
} from "./engagement.ts";

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
    out.push("", "**Evidence**", "", finding.evidence.trim(), "");
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
