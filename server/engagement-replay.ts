import { PROOF_HTTP_METHODS, type EngagementProof, type EngagementScope, type ProofHttpMethod, type ProofReplay } from "../shared/engagement.ts";
import { hostInScope } from "./engagement.ts";

// Runs a finding's reproduction against the client's own asset and reports what came back, so `proven` is a
// fact the product checked rather than a word the agent chose.
//
// Two limits it does not hide. The request leaves from this process, so a target that answers only from
// inside the client's network is unreachable here; and the scope check is the same text-level one that gates
// commands (server/engagement.ts), applied to the URL's authority rather than to a whole command.

const MAX_URL = 2048;
const MAX_HEADERS = 20;
const MAX_HEADER_NAME = 100;
const MAX_HEADER_VALUE = 2000;
const MAX_BODY = 64 * 1024;
const MAX_EXPECT = 2000;
const MAX_EXCERPT = 600;
const REPLAY_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export type ParsedProof =
  | { ok: true; proof: EngagementProof }
  | { ok: false; error: string };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Headers a caller may not set: the replay's own framing, and anything that would let a finding rewrite the
 * request's meaning or read the host's environment through a proxy. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-connection", "expect", "keep-alive",
]);

export function parseProof(value: unknown): ParsedProof {
  if (!record(value)) return { ok: false, error: "A proof must be an object." };
  const kind = value.kind ?? "http";
  if (kind !== "http") {
    return { ok: false, error: "Only an http proof can be replayed: one request the target answers. Record a command's output as proof text." };
  }
  const method = String(value.method ?? "GET").toUpperCase();
  if (!PROOF_HTTP_METHODS.includes(method as ProofHttpMethod)) {
    return { ok: false, error: `The proof's method must be one of ${PROOF_HTTP_METHODS.join(", ")}.` };
  }
  const url = text(value.url);
  if (!url) return { ok: false, error: "An http proof needs the url the flaw is in." };
  if (url.length > MAX_URL) return { ok: false, error: `The proof's url must be at most ${MAX_URL} characters.` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "The proof's url must be absolute, like https://api.example.com/items/1." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "The proof's url must be http or https." };
  }
  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    if (!record(value.headers)) return { ok: false, error: "The proof's headers must be an object of strings." };
    const entries = Object.entries(value.headers);
    if (entries.length > MAX_HEADERS) return { ok: false, error: `The proof may set at most ${MAX_HEADERS} headers.` };
    const out: Record<string, string> = {};
    for (const [name, raw] of entries) {
      const lower = name.toLowerCase();
      if (!name || name.length > MAX_HEADER_NAME || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
        return { ok: false, error: `"${name}" is not a header name.` };
      }
      if (RESERVED_HEADERS.has(lower)) return { ok: false, error: `The replay sets ${name} itself.` };
      if (typeof raw !== "string" || raw.length > MAX_HEADER_VALUE || /[\r\n]/.test(raw)) {
        return { ok: false, error: `The header ${name} must be one line of at most ${MAX_HEADER_VALUE} characters.` };
      }
      out[name] = raw;
    }
    headers = Object.keys(out).length ? out : undefined;
  }
  const body = text(value.body);
  if (body && body.length > MAX_BODY) return { ok: false, error: `The proof's body must be at most ${MAX_BODY} characters.` };
  const expect = text(value.expect);
  if (expect && expect.length > MAX_EXPECT) return { ok: false, error: `expect must be at most ${MAX_EXPECT} characters.` };
  return {
    ok: true,
    proof: {
      kind: "http",
      method: method as ProofHttpMethod,
      url,
      ...(headers ? { headers } : {}),
      ...(body ? { body } : {}),
      ...(expect ? { expect } : {}),
    },
  };
}

/** What the report and the ledger keep of an answer: the head of it, on one line, so a table stays readable. */
function excerpt(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
}

export interface ReplayDeps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Run `proof` and say whether the flaw is still there. A proof with `expect` holds only when the answer
 * contains that text; without it the replay records the answer and holds when the target answered at all,
 * which is what a timing or header-only flaw needs. The scope is checked first: a replay never leaves the
 * authorization the client signed.
 */
export async function replayProof(
  proof: EngagementProof,
  scope: EngagementScope | null,
  deps: ReplayDeps = {},
): Promise<ProofReplay> {
  const now = deps.now ?? Date.now;
  const at = now();
  const url = new URL(proof.url);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!scope) return { at, ok: false, error: "This room has no engagement scope, so nothing may be replayed against it." };
  if (!hostInScope(scope, host)) {
    return { at, ok: false, error: `${host} is outside this engagement's authorized scope.` };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REPLAY_TIMEOUT_MS);
  try {
    let target = proof.url;
    let response: Response | null = null;
    // Every hop is checked, not just the first: `redirect: "follow"` would let an in-scope target hand the
    // replay to a host the client never authorized, and the answer would then be recorded as proof.
    for (let hop = 0; ; hop++) {
      response = await fetchImpl(target, {
        method: proof.method,
        headers: proof.headers,
        body: proof.method === "GET" || proof.method === "HEAD" ? undefined : proof.body,
        signal: controller.signal,
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) break;
      if (hop >= MAX_REDIRECTS) {
        return { at, ok: false, error: `The target redirected more than ${MAX_REDIRECTS} times.` };
      }
      const next = new URL(location, target);
      const nextHost = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (!hostInScope(scope, nextHost)) {
        return { at, ok: false, error: `${nextHost} is outside this engagement's authorized scope: the target redirected there, so the replay stopped.` };
      }
      target = next.href;
    }
    const body = proof.method === "HEAD" ? "" : await response.text();
    if (proof.expect) {
      if (!body.includes(proof.expect)) {
        return {
          at,
          ok: false,
          error: `The target answered HTTP ${response.status} but the expected text is gone, so the flaw no longer reproduces.`,
          excerpt: excerpt(body),
        };
      }
      return { at, ok: true, excerpt: excerpt(body) };
    }
    return { at, ok: true, excerpt: excerpt(`HTTP ${response.status} ${body}`) };
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    return {
      at,
      ok: false,
      error: aborted
        ? `The target did not answer within ${Math.round((deps.timeoutMs ?? REPLAY_TIMEOUT_MS) / 1000)}s.`
        : `The target could not be reached: ${error instanceof Error ? error.message : "unknown error"}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
