import { useEffect, useState } from "react";
import { Globe, Server } from "lucide-react";

import type { AssetKind, EngagementAsset } from "../../../shared/engagement";
import { readRoomAssets } from "@/lib/engagement";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Group } from "@/state/store";
import { ExpandableText } from "../ExpandableText";
import { Card, ColRow, NoteRow, RowText } from "../bot-panel/rows";

const KIND_WORD: Record<AssetKind, LocaleKey> = {
  host: "room.assets.kind.host",
  service: "room.assets.kind.service",
  "web-app": "room.assets.kind.web-app",
  endpoint: "room.assets.kind.endpoint",
  other: "room.assets.kind.other",
};

const when = (at: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

type ShownAsset = EngagementAsset & { inScope: boolean };

function AssetRow({ asset }: { asset: ShownAsset }) {
  return (
    <ColRow data-asset={asset.id}>
      <div className="flex items-start gap-2">
        <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={asset.location}>{asset.location}</span>
        <span className="shrink-0 text-[12px] font-medium text-ink-tertiary">{t(KIND_WORD[asset.kind])}</span>
      </div>
      {!asset.inScope && (
        <span role="status" className="ui-chip shrink-0 bg-danger/15 text-danger">{t("room.assets.outOfScope")}</span>
      )}
      {asset.service && (
        <div className="text-[12px] text-ink-secondary">
          <span className="me-1 font-medium text-ink-tertiary">{t("room.assets.service")}</span>
          <span dir="ltr" className="font-mono">{asset.service}</span>
        </div>
      )}
      {asset.banner && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.assets.banner")}</div>
          <ExpandableText text={asset.banner} className="font-mono" />
        </div>
      )}
      {asset.notes && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          <div className="mb-0.5 text-[12px] font-medium text-ink-tertiary">{t("room.assets.notes")}</div>
          <ExpandableText text={asset.notes} />
        </div>
      )}
      <div className="text-[12px] text-ink-tertiary">{t("room.assets.foundBy", { how: asset.discoveredBy })}</div>
      <div className="text-[12px] text-ink-tertiary">
        {asset.lastSeenAt > asset.firstSeenAt
          ? t("room.assets.seen", { when: when(asset.lastSeenAt) })
          : t("room.assets.firstSeen", { when: when(asset.firstSeenAt) })}
      </div>
    </ColRow>
  );
}

export function EngagementAssetsPage({ group }: { group: Group }) {
  const [assets, setAssets] = useState<ShownAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setAssets(null);
    setError(null);
    void readRoomAssets(group.id)
      .then((found) => { if (live) setAssets(found); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : t("room.assets.error")); });
    return () => { live = false; };
  }, [group.id]);

  if (error) return (
    <Card>
      <div role="alert" data-panel-row="assets-error" className="text-[12px] leading-relaxed text-danger">{error}</div>
    </Card>
  );
  if (assets === null) return <Card><NoteRow>{t("room.assets.loading")}</NoteRow></Card>;

  if (!assets.length) return (
    <Card>
      <ColRow data-panel-row="assets-empty">
        <RowText title={t("room.assets.none")} hint={t("room.assets.noneHint")} />
      </ColRow>
    </Card>
  );

  return (
    <Card>
      <ColRow data-panel-row="assets-count">
        <RowText
          title={
            <span className="inline-flex items-center gap-1.5">
              <Server size={14} aria-hidden="true" />
              {assets.length === 1 ? t("room.assets.one") : t("room.assets.count", { count: assets.length })}
            </span>
          }
        />
      </ColRow>
      {assets.map((asset) => <AssetRow key={asset.id} asset={asset} />)}
      <ColRow data-panel-row="assets-footnote">
        <span className="inline-flex items-start gap-1.5 text-[12px] text-ink-tertiary">
          <Globe size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          {t("room.assets.footnote")}
        </span>
      </ColRow>
    </Card>
  );
}
