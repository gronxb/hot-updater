import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { UpdateFailuresReport } from "@/lib/insights-failures";

import { UpdateFailures } from "./UpdateFailures";

const report: UpdateFailuresReport = {
  coverage: { kind: "complete", sinceMs: 0 },
  measuredAtMs: 0,
  startMs: 0,
  endMs: 1,
  failedUpdates: 4,
  failedInstallations: 3,
  downloads: 9,
  patchDownloads: 3,
  patchFallbacks: 1,
  breakdown: [
    {
      stage: "download",
      reason: "http",
      events: 3,
      details: [
        {
          resource: "artifact",
          httpStatus: 403,
          originCode: "ExpiredToken",
          transport: null,
          events: 2,
        },
        {
          resource: null,
          httpStatus: 404,
          originCode: null,
          transport: null,
          events: 1,
        },
      ],
    },
    {
      stage: "unknown",
      reason: "unknown",
      events: 1,
      details: [
        {
          resource: null,
          httpStatus: null,
          originCode: null,
          transport: null,
          events: 1,
        },
      ],
    },
  ],
  recoveries: {
    failedLaunches: 5,
    byExitReason: [{ exitReason: "CRASH", events: 3 }],
  },
};

const query = (data: UpdateFailuresReport) => ({
  data,
  error: null,
  isPending: false,
  isFetching: false,
});

describe("UpdateFailures", () => {
  afterEach(cleanup);

  it("shows counts, rates, the breakdown with what failed, and exit reasons", () => {
    render(<UpdateFailures query={query(report)} onRefresh={() => {}} />);
    const card = screen.getByRole("region", { name: "Update failures" });
    const metric = (label: string) =>
      within(card).getByText(label).closest("div")!.querySelector("dd")!
        .textContent;
    expect(metric("Failed updates")).toBe("4");
    // The failure rate of update attempts: 4 failure reports over 4 + 9
    // download reports.
    expect(metric("Attempt failure rate")).toBe("30.77%");
    // 1 fallback of 4 patch attempts.
    expect(metric("Patch fallback rate")).toBe("25.00%");
    // A release has no check metrics.
    expect(within(card).queryByText("Failed checks")).toBeNull();

    const row = within(card).getByLabelText("Download · HTTP error", {
      selector: "summary",
    });
    fireEvent.click(row);
    expect(row.closest("details")?.open).toBe(true);
    const details = within(card).getByRole("list", {
      name: "Download · HTTP error details",
    });
    expect(
      within(details).getByText("HTTP 403 · ExpiredToken · artifact"),
    ).toBeDefined();
    expect(within(details).getByText("HTTP 404")).toBeDefined();
    expect(
      within(card).getByLabelText("Unknown stage · Unknown reason", {
        selector: "summary",
      }),
    ).toBeDefined();
    expect(within(card).getByText("75.0%")).toBeDefined();

    expect(within(card).getByText("CRASH")).toBeDefined();
    // Recoveries iOS and older Android report no reason for.
    expect(within(card).getByText("Not reported")).toBeDefined();
    fireEvent.click(row);
    expect(row.closest("details")?.open).toBe(false);
  });

  it("shows a rising failure rate in percentage points and keeps investigation immediately below it", () => {
    render(
      <UpdateFailures
        query={query({
          ...report,
          previous: { attemptRate: 0.1, checkRate: null, complete: true },
        })}
        onRefresh={() => {}}
        errors={
          <section aria-label="Error investigation">Original errors</section>
        }
      />,
    );
    expect(screen.getByText("↑ +20.77 pp vs previous period")).toBeDefined();
    const investigation = screen.getByRole("region", {
      name: "Error investigation",
    });
    const breakdown = screen.getByRole("table", {
      name: "Failures by stage and reason",
    });
    expect(
      investigation.compareDocumentPosition(breakdown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows a channel's failed checks against its active installations", () => {
    render(
      <UpdateFailures
        query={query({
          ...report,
          breakdown: [],
          checks: {
            failures: 6,
            failedInstallations: 2,
            activeInstallations: 8,
          },
          recoveries: { failedLaunches: 0, byExitReason: [] },
        })}
        onRefresh={() => {}}
      />,
    );
    const card = screen.getByRole("region", { name: "Update failures" });
    const metric = (label: string) =>
      within(card).getByText(label).closest("div")!.querySelector("dd")!
        .textContent;
    expect(metric("Failed checks")).toBe("6");
    expect(metric("Check failure rate")).toBe("25.00%");
    expect(
      within(card).getByText("No update failures in this period."),
    ).toBeDefined();
    expect(within(card).getByText("No crashes in this period.")).toBeDefined();
  });

  it("keeps check-only failures separate from successful updates and unavailable patch rates", () => {
    render(
      <UpdateFailures
        query={query({
          ...report,
          failedUpdates: 0,
          failedInstallations: 0,
          downloads: 36,
          patchDownloads: 0,
          patchFallbacks: 0,
          checks: {
            failures: 3,
            failedInstallations: 3,
            activeInstallations: 36,
          },
          breakdown: [
            {
              stage: "check",
              reason: "unknown",
              events: 3,
              details: [
                {
                  resource: null,
                  httpStatus: null,
                  originCode: null,
                  transport: null,
                  events: 3,
                },
              ],
            },
          ],
        })}
        onRefresh={() => {}}
      />,
    );
    const updates = screen.getByRole("region", {
      name: "Downloads & installs",
    });
    const checks = screen.getByRole("region", { name: "Update checks" });
    expect(within(updates).getByText("0.00")).toBeDefined();
    expect(within(updates).getByText("—")).toBeDefined();
    expect(within(checks).getByText("3")).toBeDefined();
    expect(within(checks).getByText("8.33")).toBeDefined();
    const table = screen.getByRole("table", {
      name: "Failures by stage and reason",
    });
    fireEvent.click(
      within(table).getByLabelText("Update check · Unknown reason", {
        selector: "summary",
      }),
    );
    expect(within(table).getByText("No details reported")).toBeDefined();
    expect(within(table).getByText("100.0%")).toBeDefined();
  });
});
