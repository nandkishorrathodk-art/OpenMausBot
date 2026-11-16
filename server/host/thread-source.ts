// Which conversation a caller speaks from: its own, a room's, or a room job's thread that belongs to a room.
import type { BotRecord, GroupRecord, Store } from "../store.ts";

export interface ThreadSource {
  bot: BotRecord;
  group: GroupRecord | undefined;
}

export function createThreadSource(store: Pick<Store, "bot" | "taskByThread" | "groupByThread">) {
  function connectorThread(botId: string, threadId: string): ThreadSource | null {
    const bot = store.bot(botId);
    if (!bot) return null;
    if (bot.threadId === threadId) return { bot, group: undefined };
    if (store.taskByThread(botId, threadId)) return { bot, group: undefined };
    const group = store.groupByThread(threadId);
    if (group?.memberIds.includes(botId)) return { bot, group };
    return null;
  }
  function directChatOf(botId: string, threadId: string): boolean { const source = connectorThread(botId, threadId); return source !== null && !source.group; }
  /** The room a thread answers to. A parallel room job runs in a thread of its own, tied to its room by the task
   * that opened it rather than by the room's thread, so a room's rule still reaches that job's commands. */
  function roomOfThread(botId: string, threadId: string): GroupRecord | null {
    const direct = store.groupByThread(threadId);
    if (direct) return direct.memberIds.includes(botId) ? direct : null;
    const opener = store.taskByThread(botId, threadId)?.openedBy;
    if (opener?.kind !== "work" || !opener.roomLane || !opener.threadId) return null;
    const room = store.groupByThread(opener.threadId);
    return room && room.memberIds.includes(botId) ? room : null;
  }
  return { connectorThread, directChatOf, roomOfThread };
}
