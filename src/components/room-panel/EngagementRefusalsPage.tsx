import { useEffect, useState } from "react";
import { ShieldX } from "lucide-react";

import type { EngagementRefusal } from "../../../shared/engagement";
import { readRoomRefusals } from "@/lib/engagement";
import { t } from "@/lib/i18n";
import type { Group } from "@/state/store";
import { ExpandableText } from "../ExpandableText";
import { Card, ColRow, NoteRow, RowText } from "../bot-panel/rows";

const when = (at: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

function RefusalRow({ refusal }: { refusal: EngagementRefusal }) {
  const reason = refusal.reason === "window"
    ? refusal.window === "not started" ? t("room.refusals.windowNotStarted") : t("room.refusals.windowEnded")
    : refusal.hosts.length === 1 ? t("room.refusals.hostOne", { host: refusal.hosts[0]! })
    : t("room.refusals.hostMany", { hosts: refusal.hosts.join(", ") });
  return (
    <ColRow data-refusal={refusal.id}>
      <span className="block text-[13px] font-medium text-ink">{reason}</span>
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.refusals.command")}</div>
        <ExpandableText text={refusal.command} className="font-mono" />
      </div>
      <div className="text-[12px] text-ink-tertiary">
        {refusal.attempts > 1
          ? t("room.refusals.attempts", { count: refusal.attempts, when: when(refusal.at) })
          : t("room.refusals.at", { when: when(refusal.at) })}
      </div>
    </ColRow>
  );
}

export function EngagementRefusalsPage({ group }: { group: Group }) {
  const [refusals, setRefusals] = useState<EngagementRefusal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRefusals(null);
    setError(null);
    void readRoomRefusals(group.id)
      .then((found) => { if (live) setRefusals(found); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : t("room.refusals.error")); });
    return () => { live = false; };
  }, [group.id]);

  if (error) return (
    <Card>
      <div role="alert" data-panel-row="refusals-error" className="text-[12px] leading-relaxed text-danger">{error}</div>
    </Card>
  );
  if (refusals === null) return <Card><NoteRow>{t("room.refusals.loading")}</NoteRow></Card>;
  if (!refusals.length) return (
    <Card>
      <ColRow data-panel-row="refusals-empty">
        <RowText title={t("room.refusals.none")} hint={t("room.refusals.noneHint")} />
      </ColRow>
    </Card>
  );

  const sorted = [...refusals].sort((a, b) => b.at - a.at);
  return (
    <Card>
      <ColRow data-panel-row="refusals-count">
        <RowText
          title={
            <span className="inline-flex items-center gap-1.5">
              <ShieldX size={14} aria-hidden="true" />
              {refusals.length === 1 ? t("room.refusals.one") : t("room.refusals.count", { count: refusals.length })}
            </span>
          }
        />
      </ColRow>
      {sorted.map((refusal) => <RefusalRow key={refusal.id} refusal={refusal} />)}
    </Card>
  );
}
