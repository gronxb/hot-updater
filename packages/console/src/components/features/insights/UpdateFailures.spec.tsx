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
};

const query = (data: UpdateFailuresReport) => ({
  data,
  error: null,
  isPending: false,
  isFetching: false,
});

describe("UpdateFailures", () => {
  afterEach(cleanup);

  it("shows counts, rates, and the breakdown with what failed", () => {
    render(<UpdateFailures query={query(report)} onRefresh={() => {}} />);
    const card = screen.getByRole("region", { name: "Update failures" });
    const updates = within(card).getByRole("region", {
      name: "Downloads & installs",
    });
    // One headline: 4 failure reports over 4 + 9 download reports, then the
    // failures and installations behind it.
    expect(updates.textContent).toContain("30.77%");
    expect(updates.textContent).toContain("of update attempts failed");
    expect(updates.textContent).toContain(
      "4 failures · ≈Estimated 3 installations",
    );
    // 1 fallback of 4 patch attempts.
    expect(
      within(updates).getByText(
        "1 of 4 patch downloads fell back to the full archive",
      ),
    ).toBeDefined();
    // A release has no check metrics, and no change before a whole previous
    // period was recorded.
    expect(
      within(card).queryByRole("region", { name: "Update checks" }),
    ).toBeNull();
    expect(within(card).queryByText(/previous period/)).toBeNull();

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
      within(card).getByLabelText("Unknown stage · No reason reported", {
        selector: "summary",
      }),
    ).toBeDefined();
    expect(within(card).getByText("75.0%")).toBeDefined();
    expect(within(card).queryByText(/exit reason/i)).toBeNull();
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
        })}
        onRefresh={() => {}}
      />,
    );
    const checks = screen.getByRole("region", { name: "Update checks" });
    // 2 installations with a failed check of 8 active ones.
    expect(checks.textContent).toContain("25.00%");
    expect(checks.textContent).toContain(
      "6 failures · ≈Estimated 2 installations",
    );
    const card = screen.getByRole("region", { name: "Update failures" });
    expect(
      within(card).getByText("No update failures in this period."),
    ).toBeDefined();
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
    expect(updates.textContent).toContain("0 failures · 0 installations");
    // No patch was tried, so no patch line.
    expect(within(updates).queryByText(/patch downloads/)).toBeNull();
    expect(within(checks).getByText("8.33")).toBeDefined();
    expect(checks.textContent).toContain(
      "3 failures · ≈Estimated 3 installations",
    );
    // Most failures report no reason: the card says why.
    expect(
      screen.getByText(
        "Most report no reason: an SDK that doesn't classify failures reports every failed check, offline ones included.",
      ),
    ).toBeDefined();
    const table = screen.getByRole("table", {
      name: "Failures by stage and reason",
    });
    fireEvent.click(
      within(table).getByLabelText("Update check · No reason reported", {
        selector: "summary",
      }),
    );
    expect(within(table).getByText("No details reported")).toBeDefined();
    expect(within(table).getByText("100.0%")).toBeDefined();
  });
});
