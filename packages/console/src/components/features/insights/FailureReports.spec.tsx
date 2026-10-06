import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupFailureReports } from "@/lib/insights-errors";
import type { InsightsEventRow } from "@/lib/insights-view";

import { FailureReportsList } from "./FailureReports";

vi.mock("@/lib/insights-api", () => ({ useFailureReportsQuery: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => (
    <a href="/installations">{children}</a>
  ),
}));

const event: InsightsEventRow = {
  id: "event-1",
  type: "UPDATE_FAILED",
  installId: "device-1",
  platform: "ios",
  channel: "production",
  appVersion: "1.6.0",
  sdkVersion: "1.0.0",
  cohort: "1",
  userId: null,
  fromBundleId: "running-bundle",
  toBundleId: "running-bundle",
  receivedAtMs: Date.UTC(2026, 9, 3, 3),
  httpResponse: {
    resource: "catalog",
    path: "/release-catalogs/app-version/ios/production/1.6.0",
    status: 200,
    body: '{"releases":null}',
    bodyTruncated: false,
    receivedAtMs: Date.UTC(2026, 9, 3, 2, 59),
  },
  failure: {
    stage: "check",
    reason: "unknown",
    resource: "catalog",
    errorMessage: "Cannot read property 'releases' of null",
    errorStack: "TypeError: missing releases\n  at readCatalog (index.js:42)",
  },
};
const older = {
  ...event,
  id: "event-2",
  installId: "device-2",
  appVersion: "1.5.0",
  httpResponse: undefined,
  receivedAtMs: event.receivedAtMs - 86_400_000,
  failure: {
    ...event.failure!,
    errorStack: "TypeError: missing releases\n  at selectRelease (index.js:19)",
  },
};
afterEach(cleanup);

describe("error investigation", () => {
  it("groups identical messages across stacks, while keeping different unknown errors separate", () => {
    const other = {
      ...event,
      id: "event-3",
      failure: { ...event.failure!, errorMessage: "disk full" },
    };
    const groups = groupFailureReports([older, other, event]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.installations).toBe(2);
    expect(groups[0]?.reports.map(({ id }) => id)).toEqual([
      "event-1",
      "event-2",
    ]);
  });

  it("opens an original error and lets a developer inspect another occurrence's stack and context", async () => {
    render(
      <FailureReportsList
        pages={[
          { data: [event, older], scanned: 20, sinceMs: 0, nextCursor: null },
        ]}
        error={null}
        isPending={false}
        isFetching={false}
        hasNextPage={false}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Cannot read property/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Error details" });
    expect(within(dialog).getByText(/at readCatalog/).textContent).toBe(
      event.failure!.errorStack,
    );
    expect(within(dialog).getByText("iOS 1.6.0")).toBeDefined();
    const response = within(dialog).getByRole("region", {
      name: "Server response",
    });
    expect(
      within(response).getByText("Server response · HTTP 200"),
    ).toBeDefined();
    expect(
      within(response).getByText(event.httpResponse!.body!).textContent,
    ).toBe(event.httpResponse!.body);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByText("1.0.0")).toBeDefined();
    const occurrences = within(dialog).getByRole("region", {
      name: "Occurrences",
    });
    fireEvent.click(within(occurrences).getByRole("button", { name: /1.5.0/ }));
    expect(within(dialog).getByText(/at selectRelease/).textContent).toBe(
      older.failure.errorStack,
    );
    expect(within(dialog).getByText("iOS 1.5.0")).toBeDefined();
    expect(
      within(dialog).queryByRole("region", { name: "Server response" }),
    ).toBeNull();
    expect(within(dialog).getByText("device-2")).toBeDefined();
    expect(
      within(dialog).getByRole("link", { name: "Installation history" }),
    ).toBeDefined();
  });

  it("does not call a partial empty scan failure-free, and can continue after it", () => {
    const onLoadMore = vi.fn();
    render(
      <FailureReportsList
        pages={[{ data: [], scanned: 500, sinceMs: 0, nextCursor: "next" }]}
        error={null}
        isPending={false}
        isFetching={false}
        hasNextPage
        onLoadMore={onLoadMore}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText("No failures in the events loaded so far"),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain(
      "not period totals",
    );
    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("explains missing historical diagnostics instead of inventing a cause", async () => {
    render(
      <FailureReportsList
        pages={[
          {
            data: [
              {
                ...event,
                failure: {
                  stage: "check",
                  reason: "unknown",
                  resource: "catalog",
                },
              },
            ],
            scanned: 1,
            sinceMs: 0,
            nextCursor: null,
          },
        ]}
        error={null}
        isPending={false}
        isFetching={false}
        hasNextPage={false}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /No error message reported/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Error details" });
    expect(
      within(dialog).getByText(/This client did not send the original error/),
    ).toBeDefined();
    expect(
      within(dialog).getByText("No stack trace was sent with this report."),
    ).toBeDefined();
  });
});
