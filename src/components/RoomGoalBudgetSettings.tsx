import { SETTINGS_INLINE_INPUT, SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useEffect, useRef, useState } from "react";

import {
  goalMaxTurns,
  MAX_GOAL_MAX_TURNS,
  MIN_GOAL_MAX_TURNS,
  parseGoalMaxTurns,
} from "@/lib/goal-turn-budget";
import { api, type ConfigStatus } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { t } from "@/lib/i18n";

export function RoomGoalBudgetSettings() {
  const confirmedTurns = useStoreSelector((s) => goalMaxTurns(s.config)), dispatch = useStoreDispatch();
  const [value, setValue] = useState(String(confirmedTurns));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(String(confirmedTurns));
  }, [confirmedTurns, dirty]);

  const save = async () => {
    if (!dirty || saveInFlight.current) return;
    const parsed = parseGoalMaxTurns(value);
    if (!parsed.ok) {
      setError(t("settings.goalBudget.range"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ rooms: { goalMaxTurns: parsed.turns } }),
      });
      dispatch({ type: "configStatus", config });
      setValue(String(goalMaxTurns(config)));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.goalBudget.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.limits.goalTurns")} subtitle={t("settings.limits.goalTurnsLine")}
      message={error ? <span id="room-goal-budget-error" role="alert" className="text-danger">{error}</span> : undefined}>
      {/* The field and its unit fill the card's 160 px control column, so the field starts where the selects do. */}
      <span className="flex w-[160px] items-center gap-2 text-[13px] leading-5 text-ink-secondary">
        <input
          id="room-goal-budget"
          type="number"
          min={MIN_GOAL_MAX_TURNS}
          max={MAX_GOAL_MAX_TURNS}
          step={2}
          inputMode="numeric"
          value={value}
          disabled={saving}
          aria-label={t("settings.limits.goalTurns")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "room-goal-budget-error" : undefined}
          title={t("settings.goalBudget.help")}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(SETTINGS_INLINE_INPUT, "w-auto min-w-0 flex-1", error && "border-danger/60")}
        />
        {t("settings.goalBudget.turns")}
      </span>
    </SettingRow>
  );
}
