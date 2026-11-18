// The agents catalog's engagement_asset tool: the inventory of what an engagement's team has found inside its scope,
// room-scoped. The internal route (server/routes/engagement-assets.ts) resolves the room from this conversation.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const ENGAGEMENT_ASSET_TOOL = "engagement_asset";

const MAX_BANNER_IN_RESULT = 400;

interface WireAsset {
  id: string;
  location: string;
  kind: string;
  service?: string;
  banner?: string;
  discoveredBy: string;
  notes?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asAsset = (value: unknown): WireAsset | null =>
  record(value) && typeof value.id === "string" ? (value as unknown as WireAsset) : null;

function line(asset: WireAsset): string {
  const service = asset.service ? ` (${asset.service})` : "";
  return `- [${asset.id}] ${asset.kind} — ${asset.location}${service}`;
}

function one(asset: WireAsset): string {
  const banner = asset.banner
    ? `\nBanner: ${asset.banner.length > MAX_BANNER_IN_RESULT ? `${asset.banner.slice(0, MAX_BANNER_IN_RESULT)}…` : asset.banner}`
    : "";
  const service = asset.service ? `\nService: ${asset.service}` : "";
  const notes = asset.notes ? `\nNotes: ${asset.notes}` : "";
  return `${asset.kind} — ${asset.location}${service}${banner}${notes}\nFound by: ${asset.discoveredBy}`;
}

export async function callEngagementAssetTool(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  const action = String(args.action ?? "list");
  const { ok, body } = await context.client.apiResponse("/api/internal/assets", {
    method: "POST",
    body: JSON.stringify({
      action,
      ...(typeof args.id === "string" ? { id: args.id } : {}),
      ...(typeof args.location === "string" ? { location: args.location } : {}),
      ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
      ...(typeof args.service === "string" ? { service: args.service } : {}),
      ...(typeof args.banner === "string" ? { banner: args.banner } : {}),
      ...(typeof args.discoveredBy === "string" ? { discoveredBy: args.discoveredBy } : {}),
      ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
    }),
  });
  if (!ok) return { text: String(body.error ?? "The asset inventory could not be read."), isError: true };
  if (action === "list") {
    const assets = Array.isArray(body.assets) ? body.assets.map(asAsset).filter((asset): asset is WireAsset => asset !== null) : [];
    if (!assets.length) {
      return { text: "No assets recorded for this engagement yet. Record each host, service or endpoint as you find it, with how you found it, before you test it." };
    }
    return { text: `Assets in this engagement (${assets.length}):\n${assets.map(line).join("\n")}` };
  }
  const asset = asAsset(body.asset);
  if (!asset) return { text: "The inventory did not confirm the change.", isError: true };
  return { text: action === "record" ? `Recorded.\n${one(asset)}` : `Updated.\n${one(asset)}` };
}

export const ENGAGEMENT_ASSET_TOOL_DEFINITION = {
  name: ENGAGEMENT_ASSET_TOOL,
  description:
    "The engagement's shared inventory of what exists inside the authorized scope, one per room, every member reads and writes it. action=record adds an asset, or refreshes the one at the same location; update changes one by id (from a list) as its service or banner is learned; list reads them all. Record each host, service, web app or endpoint as soon as you find it, with discoveredBy: the command, scan or source that turned it up. This is the attack surface the findings are about — record what you find before you test it, so the next turn works from the inventory and not from memory.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "record", "update"], description: "list reads the inventory; record adds or refreshes by location; update changes one by id." },
      id: { type: "string", description: "update: the asset's id, from a list." },
      location: { type: "string", maxLength: 500, description: "record: where it is — a host, `host:port`, or a URL. update: leave out to keep it." },
      kind: { type: "string", enum: ["host", "service", "web-app", "endpoint", "other"], description: "What sort of thing it is. Defaults to host." },
      service: { type: "string", maxLength: 200, description: "The product and version it runs, when known: `nginx 1.25.3`." },
      banner: { type: "string", description: "The fingerprint that identified it: a banner, an HTTP title, a certificate subject." },
      discoveredBy: { type: "string", description: "record: the command, scan or source that turned it up. Required." },
      notes: { type: "string", description: "Optional: anything else worth keeping about it." },
    },
    required: ["action"],
  },
};
