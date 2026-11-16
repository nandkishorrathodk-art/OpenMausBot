import { describe, expect, it } from "vitest";

import { Store } from "../store.ts";
import { createThreadSource } from "./thread-source.ts";

function fixture() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const ada = store.createBot({ name: "Ada" });
  const bea = store.createBot({ name: "Bea" });
  const stranger = store.createBot({ name: "Cyd" });
  const room = store.createGroup("Engagement", [ada.id, bea.id]);
  const job = store.createGroupTask(room.id, "recon")!;
  return { store, ada, bea, stranger, room, job, source: createThreadSource(store) };
}

describe("thread source", () => {
  it("finds a bot's own conversation", () => {
    const { ada, source } = fixture();
    expect(source.connectorThread(ada.id, ada.threadId)?.bot.id).toBe(ada.id);
    expect(source.connectorThread(ada.id, ada.threadId)?.group).toBeUndefined();
    expect(source.directChatOf(ada.id, ada.threadId)).toBe(true);
  });

  it("finds a room and a room job's own thread, and refuses a room the bot is not in", () => {
    const { ada, stranger, room, job, source } = fixture();
    expect(source.connectorThread(ada.id, room.threadId)?.group?.id).toBe(room.id);
    expect(source.connectorThread(ada.id, job.threadId)?.group?.id).toBe(room.id);
    expect(source.directChatOf(ada.id, job.threadId)).toBe(false);
    expect(source.connectorThread(stranger.id, room.threadId)).toBeNull();
  });

  it("refuses a conversation that belongs to nobody", () => {
    const { ada, source } = fixture();
    expect(source.connectorThread("no-such-bot", ada.threadId)).toBeNull();
    expect(source.connectorThread(ada.id, "no-such-thread")).toBeNull();
  });

  it("resolves a parallel room job's own thread to its room, so a room's rule reaches the job", () => {
    const { store, ada, stranger, room, source } = fixture();
    // A parallel room lane: opened from the room, living in a thread of its own (index.ts's openLane).
    const lane = store.createTask(ada.id, "recon", false, undefined,
      { botId: ada.id, name: "Ada", threadId: room.threadId, kind: "work", roomLane: true, at: Date.now() }, undefined, undefined)!;
    expect(store.groupByThread(lane.threadId)).toBeUndefined();
    expect(source.roomOfThread(ada.id, lane.threadId)?.id).toBe(room.id);
    expect(source.roomOfThread(ada.id, room.threadId)?.id).toBe(room.id);
    expect(source.roomOfThread(stranger.id, lane.threadId)).toBeNull();
    expect(source.roomOfThread(ada.id, ada.threadId)).toBeNull();
  });
});
