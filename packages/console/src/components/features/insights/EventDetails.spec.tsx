import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EventTimestamp, EventTypeBadge } from "./EventDetails";

describe("Insights event details", () => {
  afterEach(cleanup);

  it("shows a browser-zone timestamp with its numeric GMT offset", () => {
    const formatter = new Intl.DateTimeFormat("en", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "Asia/Seoul",
      timeZoneName: "shortOffset",
      year: "numeric",
    });

    render(
      <EventTimestamp
        formatter={formatter}
        value={Date.UTC(2026, 6, 18, 0, 0, 0)}
      />,
    );

    expect(screen.getByText("2026/07/18 09:00:00 GMT+9")).toBeDefined();
    expect(screen.getByText("2026-07-18 00:00:00.000 UTC")).toBeDefined();
  });

  it("uses distinct semantic labels for update, recovery, and activity events", () => {
    const { rerender } = render(<EventTypeBadge type="UPDATE_APPLIED" />);
    expect(screen.getByText("Bundle applied")).toBeDefined();

    rerender(<EventTypeBadge type="RECOVERED" />);
    expect(screen.getByText("Recovered")).toBeDefined();

    rerender(<EventTypeBadge type="UNCHANGED" />);
    expect(screen.getByText("Activity reported")).toBeDefined();
  });
});
