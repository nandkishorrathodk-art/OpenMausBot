import { describe, expect, it } from "vitest";

import type { EngagementFinding, EngagementScope } from "./engagement";
import { buildEngagementReport, engagementReportFilename } from "./engagement-report";

const scope: EngagementScope = {
  targets: ["acme.test", "*.acme.test"],
  offLimits: ["admin.acme.test"],
  startsAt: Date.UTC(2026, 10, 1),
  endsAt: Date.UTC(2026, 10, 15),
};
const at = (finding: Partial<EngagementFinding> = {}): EngagementFinding => ({
  id: "f-1", target: "api.acme.test", title: "IDOR on invoices", severity: "critical", status: "proven",
  evidence: "GET /invoices/42 as another user returns their invoice",
  reportedAt: Date.UTC(2026, 10, 2), updatedAt: Date.UTC(2026, 10, 2), ...finding,
});
const report = (findings: EngagementFinding[], s: EngagementScope | null = scope) =>
  buildEngagementReport({ room: "Acme Q4 engagement", scope: s, findings, generatedAt: new Date(Date.UTC(2026, 10, 15, 9, 30)) });

describe("the engagement report", () => {
  it("names the room, the targets, the off-limits list and the window", () => {
    const text = report([]);
    expect(text).toContain("# Engagement report — Acme Q4 engagement");
    expect(text).toContain("Generated 2026-11-15 09:30 UTC");
    expect(text).toContain("Authorized targets: acme.test, *.acme.test");
    expect(text).toContain("Off-limits: admin.acme.test");
    expect(text).toContain("Window: 2026-11-01 00:00 UTC → 2026-11-15 00:00 UTC");
  });

  it("says the scope was never set, and that nothing was found, when both are empty", () => {
    const text = report([], null);
    expect(text).toContain("No scope was set for this room.");
    expect(text).toContain("Authorized targets: none");
    expect(text).toContain("Off-limits: none");
    expect(text).toContain("No findings were recorded under this scope.");
    expect(text).not.toContain("## Findings");
  });

  it("counts proven findings apart from suspected ones, and severity worst first", () => {
    const text = report([
      at({ id: "a", severity: "medium", status: "suspected", title: "Open redirect" }),
      at({ id: "b", severity: "critical", status: "proven" }),
      at({ id: "c", severity: "low", status: "fixed", title: "Missing header" }),
    ]);
    expect(text).toContain("- Findings: 3");
    expect(text).toContain("- Proven: 1");
    expect(text).toContain("- Suspected: 1");
    expect(text).toContain("- By severity: Critical 1, Medium 1, Low 1");
    expect(text.indexOf("| Critical |")).toBeLessThan(text.indexOf("| Medium |"));
    expect(text.indexOf("| Medium |")).toBeLessThan(text.indexOf("| Low |"));
  });

  it("gives each finding its target, status, evidence and detail", () => {
    const text = report([at({ detail: "Any authenticated user can read any invoice." })]);
    expect(text).toContain("### Critical — IDOR on invoices");
    expect(text).toContain("- Target: `api.acme.test`");
    expect(text).toContain("- Status: Proven");
    expect(text).toContain("- Reported: 2026-11-02 00:00 UTC");
    expect(text).toContain("**Evidence**");
    expect(text).toContain("GET /invoices/42 as another user returns their invoice");
    expect(text).toContain("**Detail**");
    expect(text).toContain("Any authenticated user can read any invoice.");
  });

  it("shows an update time only once the finding has moved past its report", () => {
    expect(report([at()])).not.toContain("- Updated:");
    expect(report([at({ updatedAt: Date.UTC(2026, 10, 9) })])).toContain("- Updated: 2026-11-09 00:00 UTC");
  });

  it("keeps a title or target with a newline or a mark from breaking the table", () => {
    const text = report([at({ title: "Line one\nline two", target: "a|b.test" })]);
    expect(text).toContain("| Critical | Proven | a\\|b.test | Line one line two |");
  });

  it("names the file after the room, and falls back when the name has nothing usable", () => {
    expect(engagementReportFilename("Acme Q4 engagement", new Date(Date.UTC(2026, 10, 15))))
      .toBe("acme-q4-engagement-report-2026-11-15.md");
    expect(engagementReportFilename("  ***  ", new Date(Date.UTC(2026, 0, 2)))).toBe("engagement-report-2026-01-02.md");
  });
});
