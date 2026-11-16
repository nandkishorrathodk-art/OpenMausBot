import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import type { EngagementScope } from "../../../shared/engagement";
import { cn } from "@/lib/cn";
import { readRoomScope, saveRoomScope } from "@/lib/engagement";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Group } from "@/state/store";
import { buttonCls, Card, ColRow, NoteRow, RowText } from "../bot-panel/rows";

const inputCls = "w-full rounded-lg border border-hairline bg-inset px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border";
const fieldCls = "min-w-0 flex-1 space-y-1.5 text-[12px] text-ink-secondary";

/** A list of targets as the person types it: one per line, or comma- or space-separated. */
const toList = (text: string): string[] => text.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
const toText = (list: readonly string[]): string => list.join("\n");

/** Epoch ms as a `datetime-local` value in this computer's zone, or "" when there is none. */
function toLocalInput(at: number | undefined): string {
  if (at === undefined) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as epoch ms, or undefined when it is empty or unreadable. */
function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : undefined;
}

export function EngagementScopePage({ group }: { group: Group }) {
  const ownerOrAdmin = useOwnerOrAdmin();
  const [scope, setScope] = useState<EngagementScope | null | undefined>(undefined);
  const [targets, setTargets] = useState("");
  const [offLimits, setOffLimits] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const show = (next: EngagementScope | null) => {
    setScope(next);
    setTargets(toText(next?.targets ?? []));
    setOffLimits(toText(next?.offLimits ?? []));
    setStartsAt(toLocalInput(next?.startsAt));
    setEndsAt(toLocalInput(next?.endsAt));
  };

  useEffect(() => {
    if (ownerOrAdmin === false) return;
    let live = true;
    void readRoomScope(group.id)
      .then((found) => { if (live) show(found); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [group.id, ownerOrAdmin]);

  if (ownerOrAdmin === false) return <Card><NoteRow>{t("room.engagement.adminOnly")}</NoteRow></Card>;

  const edited = (set: (value: string) => void) => (value: string) => { setSaved(false); set(value); };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      show(await saveRoomScope(group.id, {
        targets: toList(targets),
        offLimits: toList(offLimits),
        ...(fromLocalInput(startsAt) === undefined ? {} : { startsAt: fromLocalInput(startsAt) }),
        ...(fromLocalInput(endsAt) === undefined ? {} : { endsAt: fromLocalInput(endsAt) }),
      }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      show(await saveRoomScope(group.id, null));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const status = saved ? t("room.engagement.saved")
    : scope === undefined ? t("room.engagement.loading")
    : scope === null ? t("room.engagement.noScope")
    : scope.targets.length === 1 ? t("room.engagement.targetOne") : t("room.engagement.targetCount", { count: scope.targets.length });

  return (
    <Card>
      {scope === null && (
        <ColRow data-panel-row="scope-empty">
          <RowText title={t("room.engagement.noScope")} hint={t("room.engagement.noScopeHint")} />
        </ColRow>
      )}
      <ColRow data-panel-row="scope-targets">
        <RowText title={t("room.engagement.targets")} />
        <textarea
          dir="ltr"
          aria-label={t("room.engagement.targets")}
          value={targets}
          disabled={saving}
          onChange={(event) => edited(setTargets)(event.target.value)}
          placeholder={t("room.engagement.targetsPlaceholder")}
          rows={3}
          className={cn(inputCls, "resize-y font-mono")}
        />
      </ColRow>
      <ColRow data-panel-row="scope-off-limits">
        <RowText title={t("room.engagement.offLimits")} />
        <textarea
          dir="ltr"
          aria-label={t("room.engagement.offLimits")}
          value={offLimits}
          disabled={saving}
          onChange={(event) => edited(setOffLimits)(event.target.value)}
          placeholder={t("room.engagement.offLimitsPlaceholder")}
          rows={2}
          className={cn(inputCls, "resize-y font-mono")}
        />
      </ColRow>
      <ColRow data-panel-row="scope-window">
        <RowText title={t("room.engagement.window")} hint={t("room.engagement.windowHint")} />
        <div className="flex flex-wrap gap-2">
          <label className={fieldCls}>
            <span className="block">{t("room.engagement.startsAt")}</span>
            <input
              type="datetime-local"
              value={startsAt}
              disabled={saving}
              onChange={(event) => edited(setStartsAt)(event.target.value)}
              className={inputCls}
            />
          </label>
          <label className={fieldCls}>
            <span className="block">{t("room.engagement.endsAt")}</span>
            <input
              type="datetime-local"
              value={endsAt}
              disabled={saving}
              onChange={(event) => edited(setEndsAt)(event.target.value)}
              className={inputCls}
            />
          </label>
        </div>
      </ColRow>
      <ColRow data-panel-row="scope-actions">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary">
            <ShieldCheck size={14} aria-hidden="true" />
            {status}
          </span>
          <span className="flex items-center gap-2">
            {scope !== null && scope !== undefined && (
              <button type="button" onClick={() => void clear()} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
                {t("room.engagement.clear")}
              </button>
            )}
            <button type="button" onClick={() => void save()} disabled={saving || !toList(targets).length} className={buttonCls}>
              {t("room.engagement.save")}
            </button>
          </span>
        </div>
        {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      </ColRow>
    </Card>
  );
}
