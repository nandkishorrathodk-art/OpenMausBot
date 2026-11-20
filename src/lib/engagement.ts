import { engagementReportFilename, type EngagementRefusal, type EngagementScope, type RoomAssetsResponse, type RoomFindingsResponse, type RoomRefusalsResponse, type RoomScopeResponse } from "../../shared/engagement";
import { downloadMarkdownTranscript } from "./export-transcript";
import { api, ApiError } from "@/state/store";

/** The room's engagement scope, or null when it has none. Owner or admin only; the server refuses anyone else. */
export async function readRoomScope(roomId: string): Promise<EngagementScope | null> {
  return (await api<RoomScopeResponse>(`/api/groups/${encodeURIComponent(roomId)}/scope`)).scope;
}

/** Sets the room's scope, or clears it with null. Returns what the server kept, normalized. */
export async function saveRoomScope(roomId: string, scope: EngagementScope | null): Promise<EngagementScope | null> {
  return (await api<RoomScopeResponse>(`/api/groups/${encodeURIComponent(roomId)}/scope`, {
    method: "PUT",
    body: JSON.stringify({ scope }),
  })).scope;
}

/** The flaws the engagement has recorded, worst first. */
export async function readRoomFindings(roomId: string): Promise<RoomFindingsResponse["findings"]> {
  return (await api<RoomFindingsResponse>(`/api/groups/${encodeURIComponent(roomId)}/findings`)).findings;
}

/** What the engagement has found inside its scope, with each asset flagged against the room's current scope. */
export async function readRoomAssets(roomId: string): Promise<RoomAssetsResponse["assets"]> {
  return (await api<RoomAssetsResponse>(`/api/groups/${encodeURIComponent(roomId)}/assets`)).assets;
}

/** The commands the engagement's scope refused, most recent first. */
export async function readRoomRefusals(roomId: string): Promise<EngagementRefusal[]> {
  return (await api<RoomRefusalsResponse>(`/api/groups/${encodeURIComponent(roomId)}/refusals`)).refusals;
}

/** Saves the engagement's client report as a markdown file. The server renders it, so the download and any
 * other reader of the route see the same words. */
export async function downloadRoomReport(roomId: string, roomName: string): Promise<void> {
  const response = await fetch(`/api/groups/${encodeURIComponent(roomId)}/report`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = (body as { error?: unknown }).error;
    throw new ApiError(typeof error === "string" ? error : `${response.status} ${response.statusText}`, response.status);
  }
  downloadMarkdownTranscript(engagementReportFilename(roomName), await response.text());
}
