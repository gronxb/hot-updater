import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ReportingDevicesSummary } from "./ReportingDevicesSummary";

afterEach(cleanup);
it("shows only the active metric and changes its definition with the selected period", async () => {
  const view = render(
    <ReportingDevicesSummary
      window="24h"
      count={3}
      isPending={false}
      partial={false}
    />,
  );
  expect(screen.getByText("DAU")).toBeDefined();
  expect(screen.queryByText("MAU")).toBeNull();
  view.rerender(
    <ReportingDevicesSummary
      window="7d"
      count={7}
      isPending={false}
      partial={false}
    />,
  );
  expect(screen.getByText("WAU")).toBeDefined();
  expect(screen.getByText("7", { exact: true })).toBeDefined();
  view.rerender(
    <ReportingDevicesSummary
      window="30d"
      count={30}
      isPending={false}
      partial={false}
    />,
  );
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "How MAU is counted" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "last 30 days",
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("keeps unknown, zero, and partial counts distinct", () => {
  const view = render(
    <ReportingDevicesSummary
      window="24h"
      count={undefined}
      isPending={true}
      partial={false}
    />,
  );
  expect(screen.getByLabelText("Loading active users")).toBeDefined();
  expect(screen.queryByText("0")).toBeNull();
  view.rerender(
    <ReportingDevicesSummary
      window="24h"
      count={undefined}
      isPending={false}
      partial={false}
    />,
  );
  expect(screen.getByText("—")).toBeDefined();
  view.rerender(
    <ReportingDevicesSummary
      window="24h"
      count={0}
      isPending={false}
      partial={false}
    />,
  );
  expect(screen.getByText("0")).toBeDefined();
  view.rerender(
    <ReportingDevicesSummary
      window="24h"
      count={3}
      isPending={false}
      partial={true}
    />,
  );
  expect(screen.getByText("≥3")).toBeDefined();
});
