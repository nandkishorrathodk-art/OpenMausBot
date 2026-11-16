import { useEffect, useState } from "react";
import { Bug } from "lucide-react";

import type { EngagementFinding, FindingSeverity, FindingStatus } from "../../../shared/engagement";
import { cn } from "@/lib/cn";
import { readRoomFindings } from "@/lib/engagement";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Group } from "@/state/store";
import { ExpandableText } from "../ExpandableText";
import { Card, ColRow, NoteRow, RowText } from "../bot-panel/rows";

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  critical: "bg-danger/15 text-danger",
  high: "bg-danger/12 text-danger",
  medium: "bg-warning/15 text-warning",
  low: "bg-ink/[0.06] text-ink-secondary",
  info: "bg-ink/[0.04] text-ink-secondary",
};
const STATUS_TONE: Record<FindingStatus, string> = {
  suspected: "bg-ink/[0.06] text-ink-secondary",
  proven: "bg-accent/12 text-accent",
  fixed: "bg-accent/12 text-accent",
  "wont-fix": "bg-ink/[0.04] text-ink-tertiary",
};
const SEVERITY_WORD: Record<FindingSeverity, LocaleKey> = {
  critical: "room.findings.severity.critical",
  high: "room.findings.severity.high",
  medium: "room.findings.severity.medium",
  low: "room.findings.severity.low",
  info: "room.findings.severity.info",
};
const STATUS_WORD: Record<FindingStatus, LocaleKey> = {
  suspected: "room.findings.status.suspected",
  proven: "room.findings.status.proven",
  fixed: "room.findings.status.fixed",
  "wont-fix": "room.findings.status.wont-fix",
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const when = (at: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

function Chip({ tone, children }: { tone: string; children: string }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}>{children}</span>;
}

function FindingRow({ finding }: { finding: EngagementFinding }) {
  return (
    <ColRow data-finding={finding.id}>
      <span className="block text-[13px] font-medium text-ink" title={finding.title}>{finding.title}</span>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="mb-0.5 block text-[11px] font-medium text-ink-tertiary">{t("room.findings.target")}</span>
          <span dir="ltr" className="block truncate font-mono text-[12px] text-ink-secondary" title={finding.target}>{finding.target}</span>
        </span>
        <span className="shrink-0 space-y-1 text-right">
          <span className="block text-[11px] font-medium text-ink-tertiary">{t("room.findings.severity")}</span>
          <Chip tone={SEVERITY_TONE[finding.severity]}>{t(SEVERITY_WORD[finding.severity])}</Chip>
        </span>
        <span className="shrink-0 space-y-1 text-right">
          <span className="block text-[11px] font-medium text-ink-tertiary">{t("room.findings.status")}</span>
          <Chip tone={STATUS_TONE[finding.status]}>{t(STATUS_WORD[finding.status])}</Chip>
        </span>
      </div>
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        <div className="mb-0.5 text-[11px] font-medium text-ink-tertiary">{t("room.findings.evidence")}</div>
        <ExpandableText text={finding.evidence} className="font-mono" />
      </div>
      {finding.detail && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[11px] font-medium text-ink-tertiary">{t("room.findings.detail")}</div>
          <ExpandableText text={finding.detail} />
        </div>
      )}
      <div className="text-[11px] text-ink-tertiary">
        {finding.updatedAt > finding.reportedAt
          ? t("room.findings.updated", { when: when(finding.updatedAt) })
          : t("room.findings.reported", { when: when(finding.reportedAt) })}
      </div>
    </ColRow>
  );
}

export function EngagementFindingsPage({ group }: { group: Group }) {
  const [findings, setFindings] = useState<EngagementFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFindings(null);
    setError(null);
    void readRoomFindings(group.id)
      .then((found) => { if (live) setFindings(found); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : t("room.findings.error")); });
    return () => { live = false; };
  }, [group.id]);

  if (error) return <Card><NoteRow tone="warn">{error}</NoteRow></Card>;
  if (findings === null) return <Card><NoteRow>{t("room.findings.loading")}</NoteRow></Card>;
  if (!findings.length) return (
    <Card>
      <ColRow data-panel-row="findings-empty">
        <RowText title={t("room.findings.none")} hint={t("room.findings.noneHint")} />
      </ColRow>
    </Card>
  );

  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.reportedAt - a.reportedAt);
  return (
    <Card>
      <ColRow data-panel-row="findings-count">
        <RowText
          title={
            <span className="inline-flex items-center gap-1.5">
              <Bug size={14} aria-hidden="true" />
              {findings.length === 1 ? t("room.findings.one") : t("room.findings.count", { count: findings.length })}
            </span>
          }
        />
      </ColRow>
      {sorted.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
    </Card>
  );
}
