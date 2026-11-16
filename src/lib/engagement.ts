import type { EngagementScope, RoomFindingsResponse, RoomScopeResponse } from "../../shared/engagement";
import { api } from "@/state/store";

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
