import type { Routine } from "../routines.ts";

export const WATCH_NAME = "Keep an eye on my day";
export const WATCH_INSTRUCTIONS = [
  "Keep an eye on my day for me.",
  "- Our work: watch what our operators and automations did since the last check, and tell me only what needs me: a run that failed, stalled or could not start, and anything waiting on a decision of mine. Say plainly what it was doing and what you would do next.",
  "- Email: pick what I must not miss: mail that needs my reply, mail from someone I meet today, and anything with a deadline. Leave out newsletters, receipts and notifications.",
  "- Meetings: before a meeting with other people, prepare me in a few lines: who they are, why we are meeting, what is still open, and one next step.",
].join("\n");
export const WATCH_EVERY_MINUTES = 15;

/** The default watch as the server made it: on, and named, worded and timed as made. One the person paused or changed
 * is theirs. */
export function watchAsMade(routine: Pick<Routine, "name" | "prompt" | "enabled" | "deliver" | "schedule">): boolean {
  return routine.deliver === "brief" && routine.enabled && routine.name === WATCH_NAME && routine.prompt === WATCH_INSTRUCTIONS
    && routine.schedule.type === "interval" && routine.schedule.everyMinutes === WATCH_EVERY_MINUTES;
}
