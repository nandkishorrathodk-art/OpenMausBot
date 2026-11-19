// A room's own limits, read from the config the server loaded.
import { z } from "zod";

import type { AppConfig } from "./config.ts";

export const DEFAULT_ROOM_TURN_TIMEOUT_MINUTES = 5;
export const MIN_ROOM_TURN_TIMEOUT_MINUTES = 1;
export const MAX_ROOM_TURN_TIMEOUT_MINUTES = 1_440;

export const DEFAULT_ROOM_GOAL_MAX_TURNS = 13;
export const MIN_ROOM_GOAL_MAX_TURNS = 3;
export const MAX_ROOM_GOAL_MAX_TURNS = 201;

/**
 * A goal run's turn budget must be odd: a step spends a coordinator turn then a worker turn, so an
 * odd cap leaves the last turn to the coordinator, the only one that can decide the goal is done.
 */
export function oddGoalTurns(value: number): number {
  const whole = Math.round(Number.isFinite(value) ? value : DEFAULT_ROOM_GOAL_MAX_TURNS);
  const bounded = Math.min(MAX_ROOM_GOAL_MAX_TURNS, Math.max(MIN_ROOM_GOAL_MAX_TURNS, whole));
  return bounded % 2 === 1 ? bounded : bounded - 1;
}

const oddTurns = z
  .number()
  .int()
  .min(MIN_ROOM_GOAL_MAX_TURNS)
  .max(MAX_ROOM_GOAL_MAX_TURNS)
  .refine((value) => value % 2 === 1, { message: "must be an odd number" });

/** A room's limits in `config.json`; `OMB_ROOM_GOAL_MAX_TURNS` overrides the turn budget. Either may be
 * absent, because a patch can save one without naming the other, and each reader supplies its default. */
export const roomConfigSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES)
    .optional(),
  goalMaxTurns: oddTurns.optional(),
});

/** A saved patch touches only the limits it names; `saveConfig` merges the rest of the section. */
export const roomPatchSchema = z.object({
  turnTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_ROOM_TURN_TIMEOUT_MINUTES)
    .max(MAX_ROOM_TURN_TIMEOUT_MINUTES)
    .optional(),
  goalMaxTurns: oddTurns.optional(),
});

export function roomTurnTimeoutMinutes(cfg: AppConfig): number {
  return cfg.rooms?.turnTimeoutMinutes ?? DEFAULT_ROOM_TURN_TIMEOUT_MINUTES;
}

/** The turn budget for one goal run: the stored setting, then `OMB_ROOM_GOAL_MAX_TURNS`, else the default. */
export function roomGoalMaxTurns(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.OMB_ROOM_GOAL_MAX_TURNS?.trim() || NaN);
  const value = Number.isSafeInteger(override) && override > 0 ? override : cfg.rooms?.goalMaxTurns ?? DEFAULT_ROOM_GOAL_MAX_TURNS;
  return oddGoalTurns(value);
}
