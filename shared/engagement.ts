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
  detail?: string;
  reportedAt: number;
  updatedAt: number;
}

/** GET /api/groups/:id/findings. */
export interface RoomFindingsResponse {
  findings: EngagementFinding[];
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
