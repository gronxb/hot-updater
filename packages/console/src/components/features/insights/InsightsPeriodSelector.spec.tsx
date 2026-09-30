import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UsagePeriodSelector } from "./InsightsPeriodSelector";

afterEach(cleanup);

const periods = () =>
  within(screen.getByRole("tablist", { name: "Reporting period" }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

describe("UsagePeriodSelector", () => {
  it("offers 12 months only where daily totals cover them", () => {
    render(<UsagePeriodSelector window="24h" onWindowChange={vi.fn()} />);
    expect(periods()).toEqual(["24h", "7d", "30d", "12m"]);
    cleanup();

    render(
      <UsagePeriodSelector
        window="24h"
        onWindowChange={vi.fn()}
        twelveMonths={false}
      />,
    );
    expect(periods()).toEqual(["24h", "7d", "30d"]);
  });
});
