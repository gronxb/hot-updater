import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ReportingDevicesSummary } from "./ReportingDevicesSummary";

const mocks = vi.hoisted(() => ({ reporting: vi.fn() }));
vi.mock("@/lib/insights-api", () => ({
  useReportingInstallationsQuery: mocks.reporting,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("counts monthly active users by installation in the applied platform and channel", () => {
  mocks.reporting.mockReturnValue({
    data: { reportingInstallations: { count: 3 } },
  });
  const view = render(
    <ReportingDevicesSummary
      scope={{ platform: "ios", channel: "production" }}
    />,
  );
  expect(screen.getByText("3", { exact: true })).toBeDefined();
  expect(mocks.reporting).toHaveBeenLastCalledWith({
    platform: "ios",
    channel: "production",
    window: "30d",
  });
  view.rerender(
    <ReportingDevicesSummary
      scope={{ platform: "android", channel: "beta" }}
    />,
  );
  expect(mocks.reporting).toHaveBeenLastCalledWith({
    platform: "android",
    channel: "beta",
    window: "30d",
  });
});

it("distinguishes loading and a failed count from a measured zero and permits retry", () => {
  const scope = { platform: "ios", channel: "production" } as const;
  const refetch = vi.fn();
  mocks.reporting.mockReturnValue({ isPending: true });
  const view = render(<ReportingDevicesSummary scope={scope} />);
  expect(screen.getByLabelText("Loading monthly active users")).toBeDefined();
  expect(screen.queryByText("0", { exact: true })).toBeNull();
  mocks.reporting.mockReturnValue({ error: new Error("Offline"), refetch });
  view.rerender(<ReportingDevicesSummary scope={scope} />);
  expect(screen.getByText("Unavailable")).toBeDefined();
  expect(screen.queryByText("0", { exact: true })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry monthly active user count" }),
  );
  expect(refetch).toHaveBeenCalledOnce();
  mocks.reporting.mockReturnValue({
    data: { reportingInstallations: { count: 0 } },
  });
  view.rerender(<ReportingDevicesSummary scope={scope} />);
  expect(screen.getByText("0", { exact: true })).toBeDefined();
  expect(screen.queryByText("Unavailable")).toBeNull();
});

it("discloses the MAU definition on tap and dismisses it with Escape", async () => {
  mocks.reporting.mockReturnValue({
    data: { reportingInstallations: { count: 3 } },
  });
  render(
    <ReportingDevicesSummary
      scope={{ platform: "ios", channel: "production" }}
    />,
  );
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "How MAU is counted" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "Unique app installations",
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
