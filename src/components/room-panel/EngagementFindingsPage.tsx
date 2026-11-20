import { useEffect, useState } from "react";
import { Bug, Download } from "lucide-react";

import type { EngagementFinding, FindingSeverity, FindingStatus } from "../../../shared/engagement";
import { cn } from "@/lib/cn";
import { downloadRoomReport, readRoomFindings } from "@/lib/engagement";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Group } from "@/state/store";
import { ExpandableText } from "../ExpandableText";
import { Card, ColRow, NoteRow, RowText } from "../bot-panel/rows";

const SEVERITY_TONE: Record<FindingSeverity, string> = {
  critical: "bg-danger/15 text-danger",
  high: "bg-danger/15 text-danger",
  medium: "bg-warning/15 text-warning",
  low: "bg-ink/[0.06] text-ink-secondary",
  info: "bg-ink/[0.04] text-ink-secondary",
};
const STATUS_TONE: Record<FindingStatus, string> = {
  suspected: "bg-ink/[0.06] text-ink-secondary",
  proven: "bg-success/15 text-success",
  fixed: "bg-success/15 text-success",
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
  return <span className={cn("ui-chip shrink-0", tone)}>{children}</span>;
}

function FindingRow({ finding }: { finding: EngagementFinding }) {
  return (
    <ColRow data-finding={finding.id}>
      <span className="block text-[13px] font-medium text-ink" title={finding.title}>{finding.title}</span>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="mb-0.5 block text-[12px] font-medium text-ink-tertiary">{t("room.findings.target")}</span>
          <span dir="ltr" className="block truncate font-mono text-[12px] text-ink-secondary" title={finding.target}>{finding.target}</span>
        </span>
        <span className="shrink-0 space-y-1 text-end">
          <span className="block text-[12px] font-medium text-ink-tertiary">{t("room.findings.severity")}</span>
          <Chip tone={SEVERITY_TONE[finding.severity]}>{t(SEVERITY_WORD[finding.severity])}</Chip>
        </span>
        <span className="shrink-0 space-y-1 text-end">
          <span className="block text-[12px] font-medium text-ink-tertiary">{t("room.findings.status")}</span>
          <Chip tone={STATUS_TONE[finding.status]}>{t(STATUS_WORD[finding.status])}</Chip>
        </span>
      </div>
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.findings.evidence")}</div>
        <ExpandableText text={finding.evidence} className="font-mono" />
      </div>
      {finding.repro && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.findings.replay")}</div>
          <ExpandableText text={`${finding.repro.method} ${finding.repro.url}`} className="font-mono" />
          <div className="mt-1 text-ink-tertiary">
            {finding.replay
              ? finding.replay.ok
                ? t("room.findings.replayHeld", { when: when(finding.replay.at) })
                : t("room.findings.replayFailed", { when: when(finding.replay.at) })
              : t("room.findings.replayPending")}
          </div>
        </div>
      )}
      {finding.proof && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.findings.proof")}</div>
          <ExpandableText text={finding.proof} className="font-mono" />
        </div>
      )}
      {finding.detail && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.findings.detail")}</div>
          <ExpandableText text={finding.detail} />
        </div>
      )}
      <div className="text-[12px] text-ink-tertiary">
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFindings(null);
    setError(null);
    void readRoomFindings(group.id)
      .then((found) => { if (live) setFindings(found); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : t("room.findings.error")); });
    return () => { live = false; };
  }, [group.id]);

  const download = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await downloadRoomReport(group.id, group.name);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t("room.report.failed"));
    } finally {
      setSaving(false);
    }
  };

  if (error) return (
    <Card>
      <div role="alert" data-panel-row="findings-error" className="text-[12px] leading-relaxed text-danger">{error}</div>
    </Card>
  );
  if (findings === null) return <Card><NoteRow>{t("room.findings.loading")}</NoteRow></Card>;

  const reportButton = (
    <button
      type="button"
      data-panel-row="report-download"
      onClick={() => void download()}
      disabled={saving}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-50"
    >
      <Download size={14} aria-hidden="true" />
      {t("room.report.download")}
    </button>
  );

  if (!findings.length) return (
    <Card>
      <ColRow data-panel-row="findings-empty">
        <RowText title={t("room.findings.none")} hint={t("room.findings.noneHint")} />
      </ColRow>
      <ColRow data-panel-row="report-row">{reportButton}</ColRow>
      {saveError && <div role="alert" data-panel-row="report-error" className="px-3 pb-2 text-[12px] leading-relaxed text-danger">{saveError}</div>}
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
      <ColRow data-panel-row="report-row">{reportButton}</ColRow>
      {saveError && <div role="alert" data-panel-row="report-error" className="px-3 pb-2 text-[12px] leading-relaxed text-danger">{saveError}</div>}
    </Card>
  );
}
