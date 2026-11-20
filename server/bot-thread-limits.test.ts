import { describe, expect, it } from "vitest";
import { threadCapacityCheck, type ThreadCapacityView } from "./bot-thread-limits.ts";

const view = (overrides: Partial<ThreadCapacityView> = {}): ThreadCapacityView => ({
  tasks: () => [],
  laneOwned: () => false,
  dispatching: () => false,
  handoffStarted: () => false,
  mainThread: () => undefined,
  limit: () => 2,
  ...overrides,
});

const atCapacity = (overrides: Partial<ThreadCapacityView> = {}) => threadCapacityCheck(view(overrides));

describe("threadCapacityCheck", () => {
  it("is free while the bot runs fewer busy threads than its limit", () => {
    expect(atCapacity({ tasks: () => [{ threadId: "a", busy: true }] })("bot")).toBe(false);
  });

  it("is at capacity at the limit and stops counting there", () => {
    const tasks = () => [{ threadId: "a", busy: true }, { threadId: "b", busy: true }, { threadId: "c", busy: true }];
    expect(atCapacity({ tasks })("bot")).toBe(true);
  });

  it("counts a thread a turn has claimed but not yet marked busy", () => {
    expect(atCapacity({ tasks: () => [{ threadId: "a" }], dispatching: (id) => id === "a", limit: () => 1 })("bot")).toBe(true);
  });

  it("ignores idle threads", () => {
    expect(atCapacity({ tasks: () => [{ threadId: "a" }, { threadId: "b" }] })("bot")).toBe(false);
  });

  it("does not count a thread a burst lane owns", () => {
    expect(atCapacity({ tasks: () => [{ threadId: "a", busy: true }, { threadId: "b", busy: true }], laneOwned: (id) => id === "b" })("bot")).toBe(false);
  });

  it("does not hold a hand-off behind the turn that started it", () => {
    const tasks = () => [{ threadId: "a", busy: true }, { threadId: "b", busy: true }];
    expect(atCapacity({ tasks, handoffStarted: (id) => id === "b" })("bot")).toBe(false);
    expect(atCapacity({ tasks, handoffStarted: (id) => id === "b" })("bot", undefined, true)).toBe(true);
  });

  it("never reports the person's own chat at capacity", () => {
    const busy = { tasks: () => [{ threadId: "a", busy: true }, { threadId: "b", busy: true }] };
    expect(atCapacity({ ...busy, mainThread: () => "a" })("bot", "a")).toBe(false);
    expect(atCapacity({ ...busy, laneOwned: (id) => id === "b" })("bot", "b")).toBe(false);
    expect(atCapacity(busy)("bot", "c")).toBe(true);
  });

  it("reads the limit for the kind of turn that asks", () => {
    const seen: boolean[] = [];
    const at = atCapacity({ tasks: () => [{ threadId: "a", busy: true }], limit: (byBot) => { seen.push(byBot); return byBot ? 1 : 2; } });
    expect(at("bot", undefined, true)).toBe(true);
    expect(at("bot")).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
