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
