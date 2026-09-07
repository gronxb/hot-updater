import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activity: vi.fn(), reporting: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/components/features/insights/InsightsOverview", () => ({
  InsightsOverview: (props: unknown) => {
    mocks.activity(props);
    return <div>Bundle activity</div>;
  },
}));
vi.mock("@/components/features/insights/InsightsPageHeader", () => ({
  InsightsPageHeader: () => <a href="/installations">All events</a>,
}));
vi.mock("@/components/features/insights/ReportingDevicesSummary", () => ({
  ReportingDevicesSummary: ({ scope }: { scope: unknown }) => {
    mocks.reporting(scope);
    return <div>Reporting devices · 30d</div>;
  },
}));

import { Route } from "./insights";
const InsightsPage = Route.options.component;
if (!InsightsPage) throw new Error("Insights route component is required");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Insights overview", () => {
  it("defaults to all IDs over 24 hours and changes only the period or platform/channel scope", () => {
    render(<InsightsPage />);
    expect(mocks.activity).toHaveBeenLastCalledWith({
      input: { platform: "ios", channel: "production", window: "24h" },
    });
    expect(screen.queryByLabelText("Bundle ID (optional)")).toBeNull();
    expect(screen.getAllByText("Bundle activity")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(mocks.activity).toHaveBeenLastCalledWith({
      input: { platform: "ios", channel: "production", window: "7d" },
    });
    expect(mocks.reporting).toHaveBeenLastCalledWith({
      platform: "ios",
      channel: "production",
    });
    fireEvent.click(screen.getByRole("button", { name: "Android" }));
    fireEvent.change(screen.getByLabelText("Channel"), {
      target: { value: "beta" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(mocks.activity).toHaveBeenLastCalledWith({
      input: { platform: "android", channel: "beta", window: "7d" },
    });
    expect(mocks.reporting).toHaveBeenLastCalledWith({
      platform: "android",
      channel: "beta",
    });
    expect(
      screen.getByRole("link", { name: "All events" }).getAttribute("href"),
    ).toBe("/installations");
  });
});
