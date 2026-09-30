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
    // 3 failed installations over 3 + 9 downloads.
    expect(metric("Failure rate")).toBe("25.00%");
    // 1 fallback of 4 patch attempts.
    expect(metric("Patch fallback rate")).toBe("25.00%");
    // A release has no check metrics.
    expect(within(card).queryByText("Failed checks")).toBeNull();

    const row = within(card).getByText("Download · HTTP error");
    fireEvent.click(row);
    const details = within(card).getByRole("list", {
      name: "Download · HTTP error details",
    });
    expect(
      within(details).getByText("HTTP 403 · ExpiredToken · artifact"),
    ).toBeDefined();
    expect(within(details).getByText("HTTP 404")).toBeDefined();
    expect(
      within(card).getByText("Unknown stage · Unknown reason"),
    ).toBeDefined();
    expect(within(card).getByText("75.0%")).toBeDefined();

    expect(within(card).getByText("CRASH")).toBeDefined();
    // Recoveries iOS and older Android report no reason for.
    expect(within(card).getByText("Not reported")).toBeDefined();
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
    expect(
      within(card).getByText("No recoveries in this period."),
    ).toBeDefined();
  });
});
