import { describe, expect, it } from "vitest";

import { DEFAULT_GOAL_MAX_TURNS, goalMaxTurns, parseGoalMaxTurns } from "./goal-turn-budget";

describe("goal run turn budget input", () => {
  it.each(["", " ", "0", "2", "1.5", "202", "24", "twenty"])("rejects %j", (value) => {
    expect(parseGoalMaxTurns(value)).toEqual({ ok: false, error: "Enter an odd whole number from 3 to 201." });
  });

  it.each([
    ["3", 3],
    ["13", 13],
    ["25", 25],
    ["201", 201],
  ])("accepts %s", (value, expected) => {
    expect(parseGoalMaxTurns(value)).toEqual({ ok: true, turns: expected });
  });

  it("reads the stored budget, or the default when none is saved", () => {
    expect(goalMaxTurns({ rooms: { goalMaxTurns: 25 } })).toBe(25);
    expect(goalMaxTurns({ rooms: {} })).toBe(DEFAULT_GOAL_MAX_TURNS);
    expect(goalMaxTurns(null)).toBe(DEFAULT_GOAL_MAX_TURNS);
    expect(goalMaxTurns(undefined)).toBe(DEFAULT_GOAL_MAX_TURNS);
  });
});
