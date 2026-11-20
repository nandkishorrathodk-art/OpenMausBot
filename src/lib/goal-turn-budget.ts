export const DEFAULT_GOAL_MAX_TURNS = 13;
export const MIN_GOAL_MAX_TURNS = 3;
export const MAX_GOAL_MAX_TURNS = 201;
export const GOAL_TURN_BUDGET_INPUT_ERROR = "Enter an odd whole number from 3 to 201.";

export type GoalTurnBudgetInput =
  | { ok: true; turns: number }
  | { ok: false; error: string };

export function parseGoalMaxTurns(value: string): GoalTurnBudgetInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: GOAL_TURN_BUDGET_INPUT_ERROR };
  const turns = Number(trimmed);
  if (turns < MIN_GOAL_MAX_TURNS || turns > MAX_GOAL_MAX_TURNS || turns % 2 === 0) {
    return { ok: false, error: GOAL_TURN_BUDGET_INPUT_ERROR };
  }
  return { ok: true, turns };
}

export function goalMaxTurns(config: { rooms?: { goalMaxTurns?: number } } | null | undefined): number {
  return config?.rooms?.goalMaxTurns ?? DEFAULT_GOAL_MAX_TURNS;
}
